import '@pefish/js-node-assist'
import BaseBitcoinWalletHelper from '@pefish/js-coin-btc/lib/base/base_bitcoinjs_lib'
import TetherRpcUtil from './rpc'
import ErrorHelper from '@pefish/js-error'

export default class TetherWalletHelper extends BaseBitcoinWalletHelper {

  [x: string]: any;

  decimals: number = 8
  bitcoinLib: any

  constructor () {
    super()
    this.bitcoinLib = require('@pefish/bitcoinjs-lib')
  }

  /**
   * 获取usdt测试币
   * @param utxos
   * @param fee
   * @param changeAddress
   * @param amount {string} 获取多少.单位shatoshi
   * @returns {Promise<*>}
   */
  async getTestnetCoin (utxos, fee, changeAddress, amount) {
    return this.buildTransaction(
      utxos,
      [
        {
          address: 'moneyqMan7uh8FqdCA2BV5yZ8qVrc9ikLP',
          amount: amount.div_(1E2)
        }
      ],
      fee,
      changeAddress,
      'testnet'
    )
  }

  /**
   * 发送tether货币(在线)
   * @param rpcClient
   * @param amount {string} 单位最小
   * @param tokenType {number} 货币类型
   * @param utxos {array} 输入
   * @param targetAddress {string} usdt打给谁
   * @param targetAmount {string} 目标地址btc，单位shatoxi，null是取最小数值
   * @param changeAddress {string} btc找零给谁
   * @param fee {string} 支付的BTC手续费. 单位最小
   * @param targets {array} btc还要打给谁
   * @param network
   * @returns {Promise<*>}
   */
  async buildSimpleSendTx (rpcClient, amount, tokenType, utxos, targetAddress, targetAmount, changeAddress, fee, targets = [], network = 'testnet') {
    if (utxos.length === 0) {
      throw new ErrorHelper(`没有输入`)
    }
    const payload = await TetherRpcUtil.createSimpleSendPayload(rpcClient, amount, tokenType)
    utxos.forEach((utxo) => {
      const { balance, index } = utxo
      utxo['value'] = balance.unShiftedBy_(this.decimals)
      utxo['vout'] = index
    })
    const unsignedRawTx = await rpcClient.createRawTransaction(utxos, {})
    const unsignedRawTxWithOpReturn = await TetherRpcUtil.attachOpReturn(rpcClient, unsignedRawTx, payload)
    let withReference = await TetherRpcUtil.attachReference(rpcClient, unsignedRawTxWithOpReturn, targetAddress, targetAmount)
    for (const {address, amount} of targets) {
      withReference = await TetherRpcUtil.attachReference(rpcClient, withReference, address, amount)
    }
    const withChange = await TetherRpcUtil.attachChangeOutput(rpcClient, withReference, utxos, changeAddress, fee.unShiftedBy_(8))
    const result = await this.signTxHex(withChange, utxos, network)
    let inputAmount = '0'
    utxos.forEach((utxo) => {
      inputAmount = inputAmount.add_(utxo['balance'])
    })

    result[`fee`] = fee.unShiftedBy_(8)
    result[`inputAmount`] = inputAmount.unShiftedBy_(8)
    return result
  }

  getOmniPayload (amount, currency = `USDT`) {
    const hexAmount = amount.decimalToHexString_(false).padStart(16, '0').toUpperCase()
    const omniPayload = [
      '6f6d6e69', // omni
      // 31 for Tether, you can modify it depends on your regtest chain
      this.getCurrencyIdByCurrency(currency).toString().decimalToHexString_(false).padStart(16, '0'),
      hexAmount,
    ].join('')
    return omniPayload
  }

  getCurrencyIdByCurrency (currency) {
    if (currency === `USDT`) {
      return 31
    } else {
      throw new ErrorHelper(`not supported`)
    }
  }

  /**
   * 离线构造SimpleSend交易
   * @param utxos {array} txid, wif {string|array}, index, balance, [sequence], [type], [pubkeys], [m]
   * @param targets {array} 发送btc的目标
   * @param fee {string} btc手续费，单位satoshi
   * @param changeAddress {string} btc找零地址
   * @param targetAddress {string} 代币目标发送地址
   * @param amount {string} 代币数量，单位最小
   * @param network
   * @param sign
   * @returns {{txHex: *|string, txId: *|string, fee: *, inputAmount: string, outputAmount: string, changeAmount: string, outputWithIndex: Array}}
   */
  buildSimpleSend (utxos, targets, fee, changeAddress, targetAddress, amount, network = `testnet`, sign = true) {
    const realNetwork = this._parseNetwork(network)
    const txBuilder = new this._bitcoin.TransactionBuilder(realNetwork, 3000)
    txBuilder.setVersion(2)
    let totalUtxoBalance = '0'
    if (utxos.length === 0) {
      throw new ErrorHelper(`没有输入`)
    }

    if (fee.gt_(`10000000`)) {
      throw new ErrorHelper(`手续费过高，请检查`)
    }

    for (const utxo of utxos) {
      const {txid, index, balance, sequence} = utxo
      if (sequence !== undefined) {
        txBuilder.addInput(txid, index, sequence)
      } else {
        txBuilder.addInput(txid, index)
      }
      totalUtxoBalance = totalUtxoBalance.add_(balance)
    }

    // 添加usdt输出
    const data = [ this.getOmniPayload(amount).hexToBuffer_() ]

    const omniOutput = this._bitcoin.payments.embed({ data }).output

    const dustValue = `546`
    txBuilder.addOutput(targetAddress, dustValue.toNumber_()) // should be first!
    txBuilder.addOutput(omniOutput, 0)

    let targetTotalAmount = '0'
    // 计算要发送出去的总额
    targets.forEach((target) => {
      const {amount} = target
      targetTotalAmount = targetTotalAmount.add_(amount.toString())
    })
    targetTotalAmount = targetTotalAmount.add_(dustValue)

    const outputWithIndex = []
    for (const target of targets) {
      const {address, amount, msg} = target
      let outputScript = address
      if (address === null && msg) {
        outputScript = this._bitcoin.script.nullData.output.encode(Buffer.from(msg, 'utf8'))
      }
      let index = null
      try {
        index = txBuilder.addOutput(outputScript, amount.toNumber_())
        outputWithIndex.push(Object.assign(target, {
          index
        }))
      } catch (err) {
        throw new ErrorHelper('构造output出错' + err['message'], 0, JSON.stringify(target), err)
      }
    }
    if (fee.lt_(1000)) {
      fee = '1000'
    }
    // 添加找零的输出
    const changeAmount = totalUtxoBalance.sub_(targetTotalAmount).sub_(fee.toString())
    if (changeAmount.lt_(0)) {
      throw new ErrorHelper(`btc balance not enough`)
    }
    if (changeAmount !== '0') {
      const amount = totalUtxoBalance.sub_(targetTotalAmount).sub_(fee.toString())
      const index = txBuilder.addOutput(changeAddress, amount.toNumber_())
      outputWithIndex.push({
        address: changeAddress,
        amount,
        index
      })
    }
    let buildedTx = null
    if (sign) {
      // 签名
      buildedTx = this._signUtxos(txBuilder, utxos, realNetwork)
    } else {
      buildedTx = txBuilder.buildIncomplete()
    }
    return {
      txHex: buildedTx.toHex(),
      txId: buildedTx.getId(),
      fee,
      inputAmount: totalUtxoBalance.toString(),
      outputAmount: targetTotalAmount.toString(),
      changeAmount: changeAmount.toString(),
      outputWithIndex
    }
  }
}