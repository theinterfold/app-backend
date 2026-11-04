import { Models } from '@dbModels'
import ConfigIndexerHelper from '@helpers/configIndexer'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import reindexBondedVotesMembersMigration, {
  reindexBondedVotesToken,
} from '@src/migrations/20261104120000-reindexBondedVotesMembers'
import { EnumQueueName, IPluginInterfaceType, IPluginStatus, ITokenType, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('migration: reindexBondedVotesMembers', () => {
  let sandbox: SinonSandbox
  let sendMessageStub: SinonStub

  const bondedAddress = '0x4444444444444444444444444444444444444444'
  const erc20Address = '0x3333333333333333333333333333333333333333'
  const pluginAddress = '0x7777777777777777777777777777777777777777'
  const crispAddress = '0x9999999999999999999999999999999999999999'
  const daoAddress = '0xabCDef1234567890abCdEF1234567890ABcDeF12'
  const network = NetworksEnum.ethereumSepolia

  const crawlService = (address: string, type = ITokenType.bondedVotes) =>
    ConfigIndexerHelper.builders.token(type, network, address)

  const createToken = (address: string, type = ITokenType.bondedVotes) =>
    Models.Token.create({ address, network, type, isGovernance: true })

  const createCrawl = (address: string, type = ITokenType.bondedVotes) =>
    Models.ConfigIndexer.create({ network, service: crawlService(address, type), lastSync: 2000, end: true })

  const createPlugin = (address: string, interfaceType: IPluginInterfaceType, status = IPluginStatus.installed) =>
    Models.Plugin.create({
      address,
      daoAddress,
      network,
      interfaceType,
      status,
      tokenAddress: bondedAddress,
      blockNumber: 1000,
      transactionHash: `0xinstall${address}`,
    })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sendMessageStub = sandbox.stub(RabbitMQHelper, 'sendMessage').resolves()
    sandbox.stub(logger, 'info')
    sandbox.stub(logger, 'verbose')
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('reindexBondedVotesToken', () => {
    it('should drop the token crawl progress so the crawl restarts from its first block', async () => {
      const token = await createToken(bondedAddress)
      await createCrawl(bondedAddress)

      await reindexBondedVotesToken(token)

      expect(await Models.ConfigIndexer.findOne({ network, service: crawlService(bondedAddress) })).to.equal(null)
    })

    it('should requeue every installed plugin that uses the token, TokenVoting and CRISP alike', async () => {
      const token = await createToken(bondedAddress)
      await createPlugin(pluginAddress, IPluginInterfaceType.tokenVoting)
      await createPlugin(crispAddress, IPluginInterfaceType.crisp)
      await createPlugin(
        '0x1212121212121212121212121212121212121212',
        IPluginInterfaceType.crisp,
        IPluginStatus.abandoned,
      )

      await reindexBondedVotesToken(token)

      const queued = sendMessageStub.getCalls().map(call => call.args)
      expect(queued.map(([queue]) => queue)).to.deep.equal([EnumQueueName.plugins, EnumQueueName.plugins])
      expect(queued.map(([, message]) => message.params.address)).to.have.members([pluginAddress, crispAddress])
    })
  })

  describe('start', () => {
    it('should reindex every BondedVotes token and leave other tokens alone', async () => {
      await createToken(bondedAddress)
      await createToken(erc20Address, ITokenType.ERC20)
      await createCrawl(bondedAddress)
      await createCrawl(erc20Address, ITokenType.ERC20)

      await reindexBondedVotesMembersMigration.start()

      expect(await Models.ConfigIndexer.findOne({ network, service: crawlService(bondedAddress) })).to.equal(null)
      expect(
        await Models.ConfigIndexer.findOne({ network, service: crawlService(erc20Address, ITokenType.ERC20) }),
      ).to.not.equal(null)
    })
  })
})
