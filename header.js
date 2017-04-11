const utils = require('ethereumjs-util')
const params = require('ethereum-common/params.json')
const BN = utils.BN
/**
 * An object that repersents the block header
 * @constructor
 * @param {Array} data raw data, deserialized
 * @prop {Buffer} parentHash the blocks' parent's hash
 * @prop {Buffer} uncleHash sha3(rlp_encode(uncle_list))
 * @prop {Buffer} coinbase the miner address
 * @prop {Buffer} stateRoot The root of a Merkle Patricia tree
 * @prop {Buffer} transactionTrie the root of a Trie containing the transactions
 * @prop {Buffer} receiptTrie the root of a Trie containing the transaction Reciept
 * @prop {Buffer} bloom
 * @prop {Buffer} difficulty
 * @prop {Buffer} number the block's height
 * @prop {Buffer} gasLimit
 * @prop {Buffer} gasUsed
 * @prop {Buffer} timestamp
 * @prop {Buffer} extraData
 */
module.exports = class BlockHeader {
  constructor () {
    this.fields = [{
      name: 'parentHash',
      length: 32,
      default: utils.zeros(32)
    }, {
      name: 'uncleHash',
      default: utils.SHA3_RLP_ARRAY
    }, {
      name: 'coinbase',
      length: 20,
      default: utils.zeros(20)
    }, {
      name: 'stateRoot',
      length: 32,
      default: utils.zeros(32)
    }, {
      name: 'transactionsTrie',
      length: 32,
      default: utils.SHA3_RLP
    }, {
      name: 'receiptTrie',
      length: 32,
      default: utils.SHA3_RLP
    }, {
      name: 'bloom',
      default: utils.zeros(256)
    }, {
      name: 'difficulty',
      default: new Buffer([])
    }, {
      name: 'number',
      default: utils.intToBuffer(params.homeSteadForkNumber.v)
    }, {
      name: 'gasLimit',
      default: new Buffer('ffffffffffffff', 'hex')
    }, {
      name: 'gasUsed',
      empty: true,
      default: new Buffer([])
    }, {
      name: 'timestamp',
      default: new Buffer([])
    }, {
      name: 'extraData',
      allowZero: true,
      empty: true,
      default: new Buffer([])
    }, {
      name: 'mixHash',
      default: utils.zeros(32)
               // length: 32
    }, {
      name: 'nonce',
      default: new Buffer([]) // sha3(42)
    }]

    this.fields.forEach((field) => {
      this[field.name] = field.default
    })
  }

  /**
   * Returns a new BlockHeader object from the provided JSON data
   * @method from
   * @param {Object} data
   * @return {BlockHeader}
   */
  static from (data) {
    const header = new BlockHeader()
    this.fields.forEach((field) => {
      // TODO validation
      //
      if (field.length) {
        if (data[field.name] > field.length) {
          throw new Error(`${field.name} can only be ${field.length} long!`)
        }
      }
      if (!field.empty && data[field.name].length === 0) {
        throw new Error(`${field.name} should not be empty!`)
      }

      if (!field.allowZero && !data[field.name]) {
        throw new Error(`${field.name} should not be zero or undefined!`)
      }

      header[field.name] = data[field.name]
    })
    return header
  }

  /**
   * Returns the canoncical difficulty of the block
   * @method canonicalDifficulty
   * @param {Block} parentBlock the parent `Block` of the this header
   * @return {BN}
   */
  canonicalDifficulty (parentBlock) {
    const blockTs = new BN(this.timestamp)
    const parentTs = new BN(parentBlock.header.timestamp)
    const parentDif = new BN(parentBlock.header.difficulty)
    const minimumDifficulty = new BN(params.minimumDifficulty.v)
    const offset = parentDif.div(new BN(params.difficultyBoundDivisor.v))
    let dif
    if (this.isHomestead()) {
        // homestead
        // 1 - (block_timestamp - parent_timestamp) // 10
      let a = blockTs.sub(parentTs).idivn(10).ineg().iaddn(1)
      const cutoff = new BN(-99)
          // MAX(cutoff, a)
      if (cutoff.cmp(a) === 1) {
        a = cutoff
      }
      dif = parentDif.add(offset.mul(a))
    } else {
        // prehomestead
      if (parentTs.addn(params.durationLimit.v).cmp(blockTs) === 1) {
        dif = offset.add(parentDif)
      } else {
        dif = parentDif.sub(offset)
      }
    }

    const exp = new BN(this.number).idivn(100000).isubn(2)
    if (!exp.isNeg()) {
      dif.iadd(new BN(2).pow(exp))
    }

    if (dif.cmp(minimumDifficulty) === -1) {
      dif = minimumDifficulty
    }

    return dif
  }

  /**
   * checks that the block's `difficuly` matches the canonical difficulty
   * @method validateDifficulty
   * @param {Block} parentBlock this block's parent
   * @return {Boolean}
   */
  validateDifficulty (parentBlock) {
    const dif = this.canonicalDifficulty(parentBlock)
    return dif.cmp(new BN(this.difficulty)) === 0
  }

  /**
   * Validates the gasLimit
   * @method validateGasLimit
   * @param {Block} parentBlock this block's parent
   * @returns {Boolean}
   */
  validateGasLimit (parentBlock) {
    const pGasLimit = utils.bufferToInt(parentBlock.header.gasLimit)
    const gasLimit = utils.bufferToInt(this.gasLimit)
    const a = Math.floor(pGasLimit / params.gasLimitBoundDivisor.v)
    const maxGasLimit = pGasLimit + a
    const minGasLimit = pGasLimit - a

    return maxGasLimit > gasLimit && minGasLimit < gasLimit && params.minGasLimit.v <= gasLimit
  }

  /**
   * Validates the entire block header
   * @method validate
   * @param {Blockchain} blockChain the blockchain that this block is validating against
   * @param {Bignum} [height] if this is an uncle header, this is the height of the block that is including it
   * @param {Function} cb the callback function. The callback is given an `error` if the block is invalid
   */
  validate (blockchain, height, cb) {
    const self = this
    if (arguments.length === 2) {
      cb = height
      height = false
    }

    if (this.isGenesis()) {
      return cb()
    }

    // find the blocks parent
    blockchain.getBlock(self.parentHash, function (err, parentBlock) {
      if (err) {
        return cb('could not find parent block')
      }

      self.parentBlock = parentBlock

      const number = new BN(self.number)
      if (number.cmp(new BN(parentBlock.header.number).iaddn(1)) !== 0) {
        return cb('invalid number')
      }

      if (height) {
        const dif = height.sub(new BN(parentBlock.header.number))
        if (!(dif.cmpn(8) === -1 && dif.cmpn(1) === 1)) {
          return cb('uncle block has a parent that is too old or to young')
        }
      }

      if (!self.validateDifficulty(parentBlock)) {
        return cb('invalid Difficulty')
      }

      if (!self.validateGasLimit(parentBlock)) {
        return cb('invalid gas limit')
      }

      if (utils.bufferToInt(parentBlock.header.number) + 1 !== utils.bufferToInt(self.number)) {
        return cb('invalid heigth')
      }

      if (utils.bufferToInt(self.timestamp) <= utils.bufferToInt(parentBlock.header.timestamp)) {
        return cb('invalid timestamp')
      }

      if (self.extraData.length > params.maximumExtraDataSize.v) {
        return cb('invalid amount of extra data')
      }

      cb()
    })
  }

  /**
   * Returns the sha3 hash of the blockheader
   * @method hash
   * @return {Buffer}
   */
  hash () {
    return utils.rlphash(this.fields.map((field) => this[field.name]))
  }

  /**
   * checks if the blockheader is a genesis header
   * @method isGenesis
   * @return {Boolean}
   */
  isGenesis () {
    return this.number.toString('hex') === ''
  }

  /**
   * Determines if a given block part of homestead or not
   * @method isHomestead
   * @return Boolean
   */
  isHomestead () {
    return utils.bufferToInt(this.number) >= params.homeSteadForkNumber.v
  }

  /**
   * Determines if a given block part of Homestead Reprice (EIP150) or not
   * @method isHomesteadReprice
   * @return Boolean
   */
  isHomesteadReprice () {
    return utils.bufferToInt(this.number) >= params.homesteadRepriceForkNumber.v
  }
  get raw () {
    return this.fields.map((field) => this[field.name])
  }
}
