import { Models } from '@dbModels'
import RabbitMQHelper from '@helpers/rabbitMQ'
import TokenDetector from '@helpers/tokenDetector'
import logger from '@logger'
import migrateBondedVotesTokensMigration, {
  findBondedVotesTokens,
  migrateBondedVotesToken,
} from '@src/migrations/20261102120000-migrateBondedVotesTokens'
import { EnumQueueName, IPluginInterfaceType, IPluginStatus, ITokenType, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('migration: migrateBondedVotesTokens', () => {
  let sandbox: SinonSandbox
  let sendMessageStub: SinonStub

  const bondedAddress = '0x4444444444444444444444444444444444444444'
  const adapterAddress = '0x2222222222222222222222222222222222222222'
  const pluginAddress = '0x7777777777777777777777777777777777777777'
  const daoAddress = '0xabCDef1234567890abCdEF1234567890ABcDeF12'
  const network = NetworksEnum.ethereumSepolia

  const createToken = (address: string, type = ITokenType.escrowAdapter) =>
    Models.Token.create({ address, network, type, isGovernance: true })

  const createPlugin = (status = IPluginStatus.installed) =>
    Models.Plugin.create({
      address: pluginAddress,
      daoAddress,
      network,
      interfaceType: IPluginInterfaceType.crisp,
      status,
      tokenAddress: bondedAddress,
      blockNumber: 1000,
      transactionHash: '0xinstall',
      votingEscrow: {
        escrowAddress: '0x8888888888888888888888888888888888888888',
        exitQueueAddress: '0x9999999999999999999999999999999999999999',
      },
    })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sendMessageStub = sandbox.stub(RabbitMQHelper, 'sendMessage').resolves()
    sandbox.stub(TokenDetector, 'detectTokenType').callsFake(async (address: string) => {
      const type = address === bondedAddress ? ITokenType.bondedVotes : ITokenType.escrowAdapter
      return { type } as any
    })
    sandbox.stub(logger, 'info')
    sandbox.stub(logger, 'verbose')
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('findBondedVotesTokens', () => {
    it('should select only stored escrow adapters whose bytecode is BondedVotes', async () => {
      await createToken(bondedAddress)
      await createToken(adapterAddress)
      await createToken('0x3333333333333333333333333333333333333333', ITokenType.ERC20)

      const tokens = await findBondedVotesTokens()

      expect(tokens.map(token => token.address)).to.deep.equal([bondedAddress])
    })
  })

  describe('migrateBondedVotesToken', () => {
    it('should re-type the token, drop the escrow indexing and requeue the plugin', async () => {
      const token = await createToken(bondedAddress)
      await createPlugin()
      await Models.Lock.create({
        tokenAddress: bondedAddress,
        network,
        tokenId: '1',
        transactionHash: '0xlock',
        transactionIndex: 0,
        logIndex: 0,
        blockNumber: 1001,
        memberAddress: '0x1111111111111111111111111111111111111111',
        escrowAddress: '0x8888888888888888888888888888888888888888',
        exitQueueAddress: '0x9999999999999999999999999999999999999999',
        nftAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      })

      await migrateBondedVotesToken(token)

      expect((await Models.Token.findOne({ address: bondedAddress, network })).type).to.equal(ITokenType.bondedVotes)
      expect((await Models.Plugin.findOne({ address: pluginAddress, network })).votingEscrow).to.equal(null)
      expect(await Models.Lock.find({ tokenAddress: bondedAddress, network })).to.have.lengthOf(0)
      expect(sendMessageStub.calledOnceWith(EnumQueueName.plugins)).to.be.true
      expect(sendMessageStub.firstCall.args[1]).to.deep.equal({
        id: pluginAddress,
        params: { address: pluginAddress, network },
      })
    })

    it('should not requeue uninstalled plugins', async () => {
      const token = await createToken(bondedAddress)
      await createPlugin(IPluginStatus.abandoned)

      await migrateBondedVotesToken(token)

      expect(sendMessageStub.called).to.be.false
    })
  })

  describe('start', () => {
    it('should migrate every BondedVotes token and leave other adapters alone', async () => {
      await createToken(bondedAddress)
      await createToken(adapterAddress)

      await migrateBondedVotesTokensMigration.start()

      expect((await Models.Token.findOne({ address: bondedAddress, network })).type).to.equal(ITokenType.bondedVotes)
      expect((await Models.Token.findOne({ address: adapterAddress, network })).type).to.equal(ITokenType.escrowAdapter)
    })
  })
})
