const ethUtil = require('ethereumjs-util')
const Tx = require('ethereumjs-tx')
const Trie = require('merkle-patricia-tree')
const BN = ethUtil.BN
const rlp = ethUtil.rlp
const async = require('async')
const BlockHeader = require('./header')
const params = require('ethereum-common/params.json')
const Message = require('primea-message')

module.exports = class Block extends Message {

/**
 * Creates a new block object
 * @constructor the raw serialized or the deserialized block.
 * @param {Array|Buffer|Object} data
 * @prop {Header} header the block's header
 * @prop {Array.<Header>} uncleList an array of uncle headers
 * @prop {Array.<Buffer>} raw an array of buffers containing the raw blocks.
 */
  constructor () {
    super()
    this.transactions = []
    this.uncleHeaders = []
    this._inBlockChain = false
    this.txTrie = new Trie()
    this.header = new BlockHeader()
  }

  /*
   * Creates a new block from the provided rlp encoded hex data
   * @method from
   * @returns {Block}
   * @param {Array} data
   */
  static from (data) {
    const block = new Block()
    let rawTransactions
    let rawUncleHeaders

    if (Buffer.isBuffer(data)) {
      data = rlp.decode(data)
    }

    if (Array.isArray(data)) {
      block.header = BlockHeader.from(data[0])
      rawTransactions = data[1]
      rawUncleHeaders = data[2]
    } else {
      block.header = BlockHeader.from(data.header)
      rawTransactions = data.transactions || []
      rawUncleHeaders = data.uncleHeaders || []
    }

    // parse uncle headers
    for (let i = 0; i < rawUncleHeaders.length; i++) {
      block.uncleHeaders.push(BlockHeader.from(rawUncleHeaders[i]))
    }

    const homestead = block.isHomestead()
      // parse transactions
    for (let i = 0; i < rawTransactions.length; i++) {
      const tx = new Tx(rawTransactions[i])
      tx._homestead = homestead
      block.transactions.push(tx)
    }
    return block
  }
  /**
   * Produces a hash the RLP of the block
   * @method hash
   */
  hash () {
    return this.header.hash()
  }

  /**
   * Determines if a given block is the genesis block
   * @method isGenisis
   * @return Boolean
   */
  isGenesis () {
    return this.header.isGenesis()
  }

  /**
   * Determines if a given block part of homestead or not
   * @method isHomestead
   * @return Boolean
   */
  isHomestead () {
    return this.header.isHomestead()
  }

  /**
   * Determines if a given block part of homestead reprice or not
   * @method isHomesteadReprice
   * @return Boolean
   */
  isHomesteadReprice () {
    return this.header.isHomesteadReprice()
  }

  /**
   * turns the block in to the canonical genesis block
   * @method setGenesisParams
   */
  setGenesisParams () {
    this.header.gasLimit = params.genesisGasLimit.v
    this.header.difficulty = params.genesisDifficulty.v
    this.header.extraData = params.genesisExtraData.v
    this.header.nonce = params.genesisNonce.v
    this.header.stateRoot = params.genesisStateRoot.v
    this.header.number = new Buffer([])
  }

  /**
   * Produces a serialization of the block.
   * @method serialize
   * @param {Boolean} rlpEncode whether to rlp encode the block or not
   */
  serialize (rlpEncode) {
    const raw = [this.header.raw, [],
    []
    ]

      // rlpEnode defaults to true
    if (typeof rlpEncode === 'undefined') {
      rlpEncode = true
    }

    this.transactions.forEach((tx) => {
      raw[1].push(tx.raw)
    })

    this.uncleHeaders.forEach((uncle) => {
      raw[2].push(uncle.raw)
    })
    return rlpEncode ? rlp.encode(raw) : raw
  }

  /**
   * Generate transaction trie. The tx trie must be generated before the transaction trie can
   * be validated with `validateTransactionTrie`
   * @method genTxTrie
   * @param {Function} cb the callback
   */
  genTxTrie (cb) {
    let i = 0
    const self = this

    async.eachSeries(this.transactions, (tx, done) => {
      self.txTrie.put(rlp.encode(i), tx.serialize(), done)
      i++
    }, cb)
  }

  /**
   * Validates the transaction trie
   * @method validateTransactionTrie
   * @return {Boolean}
   */
  validateTransactionsTrie () {
    const txT = this.header.transactionsTrie.toString('hex')
    if (this.transactions.length) {
      return txT === this.txTrie.root.toString('hex')
    } else {
      return txT === ethUtil.SHA3_RLP.toString('hex')
    }
  }

  /**
   * Validates the transactions
   * @method validateTransactions
   * @param {Boolean} [stringError=false] whether to return a string with a dscription of why the validation failed or return a Bloolean
   * @return {Boolean}
   */
  validateTransactions (stringError) {
    const errors = []

    this.transactions.forEach((tx, i) => {
      const error = tx.validate(true)
      if (error) {
        errors.push(error + ' at tx ' + i)
      }
    })

    if (stringError === undefined || stringError === false) {
      return errors.length === 0
    } else {
      return arrayToString(errors)
    }
  }

  /**
   * Validates the entire block. Returns a string to the callback if block is invalid
   * @method validate
   * @param {BlockChain} blockChain the blockchain that this block wants to be part of
   * @param {Function} cb the callback which is given a `String` if the block is not valid
   */
  validate (blockChain, cb) {
    const self = this
    const errors = []

    async.parallel([
          // validate uncles
      self.validateUncles.bind(self, blockChain),
          // validate block
      self.header.validate.bind(self.header, blockChain),
          // generate the transaction trie
      self.genTxTrie.bind(self)
    ], (err) => {
      if (err) {
        errors.push(err)
      }

      if (!self.validateTransactionsTrie()) {
        errors.push('invalid transaction true')
      }

      const txErrors = self.validateTransactions(true)
      if (txErrors !== '') {
        errors.push(txErrors)
      }

      if (!self.validateUnclesHash()) {
        errors.push('invild uncle hash')
      }

      cb(arrayToString(errors))
    })
  }

  /**
   * Validates the uncle's hash
   * @method validateUncleHash
   * @return {Boolean}
   */
  validateUnclesHash () {
    let raw = []
    this.uncleHeaders.forEach((uncle) => {
      raw.push(uncle.raw)
    })

    raw = rlp.encode(raw)
    return ethUtil.sha3(raw).toString('hex') === this.header.uncleHash.toString('hex')
  }

  /**
   * Validates the uncles that are in the block if any. Returns a string to the callback if uncles are invalid
   * @method validateUncles
   * @param {Blockchain} blockChaina an instance of the Blockchain
   * @param {Function} cb the callback
   */
  validateUncles (blockChain, cb) {
    if (this.isGenesis()) {
      return cb()
    }

    const self = this

    if (self.uncleHeaders.length > 2) {
      return cb('too many uncle headers')
    }

    const uncleHashes = self.uncleHeaders.map((header) => {
      return header.hash().toString('hex')
    })

    if (!((new Set(uncleHashes)).size === uncleHashes.length)) {
      return cb('dublicate unlces')
    }

    async.each(self.uncleHeaders, (uncle, cb2) => {
      const height = new BN(self.header.number)
      async.parallel([
        uncle.validate.bind(uncle, blockChain, height),
            // check to make sure the uncle is not already in the blockchain
        (cb3) => {
          blockChain.getDetails(uncle.hash(), (err, blockInfo) => {
                // TODO: remove uncles from BC
            if (blockInfo && blockInfo.isUncle) {
              cb3(err || 'uncle already included')
            } else {
              cb3()
            }
          })
        }
      ], cb2)
    }, cb)
  }

  /**
   * Converts the block toJSON
   * @method toJSON
   * @param {Bool} labeled whether to create an labeled object or an array
   * @return {Object}
   */
  toJSON (labeled) {
    if (labeled) {
      const obj = {
        header: this.header.toJSON(true),
        transactions: [],
        uncleHeaders: []
      }

      this.transactions.forEach((tx) => {
        obj.transactions.push(tx.toJSON(labeled))
      })

      this.uncleHeaders.forEach((uh) => {
        obj.uncleHeaders.push(uh.toJSON())
      })
      return obj
    } else {
      return ethUtil.baToJSON(this.raw)
    }
  }
  get raw () {
    return this.serialize(false)
  }
}
function arrayToString (array) {
  try {
    return array.reduce((str, err) => {
      if (str) {
        str += ' '
      }
      return str + err
    })
  } catch (e) {
    return ''
  }
}
