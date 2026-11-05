import '@test/environment'
import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import { BlockchainLogCrawler } from '@modules/crawlers'
import { LogInterfold } from '@services/aragon-plugins/logInterfold'
import { EnumQueueName, IPluginInterfaceType, IPluginStatus, NetworksEnum } from '@types'
import { expect } from 'chai'
import { Interface } from 'ethers'
import * as sinon from 'sinon'
import { SinonSandbox } from 'sinon'

describe('AragonPlugins: LogInterfold', () => {
  let sandbox: SinonSandbox

  const network = NetworksEnum.ethereumSepolia
  const coordinator = '0x3333333333333333333333333333333333333333'
  const otherCoordinator = '0x4444444444444444444444444444444444444444'
  const daoAddress = '0x6666666666666666666666666666666666666666'

  const createPlugin = (
    address: string,
    interfoldAddress: string | undefined,
    blockNumber: number,
    overrides: Record<string, unknown> = {},
  ) =>
    Models.Plugin.create({
      address,
      daoAddress,
      network,
      interfaceType: IPluginInterfaceType.crisp,
      status: IPluginStatus.installed,
      blockNumber,
      transactionHash: `0xinstall${address}`,
      interfoldAddress,
      ...overrides,
    })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.stub(logger, 'verbose')
    sandbox.stub(logger, 'error')
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('start', () => {
    // [address, fromBlock, topics] of every crawl
    const stubCrawl = () => {
      const crawls: { address: unknown; fromBlock: unknown; topics: unknown }[] = []
      sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').callsFake(async function (this: any): Promise<undefined> {
        const { address, fromBlock, topics } = this.crawlSetting.filter
        crawls.push({ address, fromBlock, topics })
        return undefined
      })
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      return crawls
    }

    it('should crawl each coordinator from the first block of the plugins using it', async () => {
      await createPlugin('0x1000000000000000000000000000000000000001', coordinator, 500)
      await createPlugin('0x1000000000000000000000000000000000000002', coordinator, 300)
      await createPlugin('0x1000000000000000000000000000000000000003', otherCoordinator, 700)
      const crawls = stubCrawl()

      await LogInterfold.start(network)

      expect(crawls.map(({ address, fromBlock }) => ({ address, fromBlock }))).to.have.deep.members([
        { address: [coordinator], fromBlock: 300 },
        { address: [otherCoordinator], fromBlock: 700 },
      ])
    })

    it('should crawl the plaintext output and failure events only', async () => {
      await createPlugin('0x1000000000000000000000000000000000000001', coordinator, 500)
      const crawls = stubCrawl()
      const abi = new Interface([
        'event PlaintextOutputPublished(uint256 indexed e3Id, bytes plaintextOutput, bytes proof)',
        'event E3Failed(uint256 indexed e3Id, uint8 failedAtStage, uint8 reason)',
      ])

      await LogInterfold.start(network)

      expect(crawls[0].topics).to.have.deep.members([
        abi.getEvent('PlaintextOutputPublished')!.topicHash,
        abi.getEvent('E3Failed')!.topicHash,
      ])
    })

    it('should skip plugins without a stored coordinator, other networks and plugins that are not installed', async () => {
      await createPlugin('0x1000000000000000000000000000000000000001', undefined, 500)
      await createPlugin('0x1000000000000000000000000000000000000002', coordinator, 500, {
        status: IPluginStatus.abandoned,
      })
      await createPlugin('0x1000000000000000000000000000000000000003', coordinator, 500, {
        network: NetworksEnum.ethereumMainnet,
      })
      await createPlugin('0x1000000000000000000000000000000000000004', coordinator, 500, {
        interfaceType: IPluginInterfaceType.tokenVoting,
      })
      const crawls = stubCrawl()

      await LogInterfold.start(network)

      expect(crawls).to.have.length(0)
    })

    it('should keep crawling the other coordinators when one fails', async () => {
      await createPlugin('0x1000000000000000000000000000000000000001', coordinator, 500)
      await createPlugin('0x1000000000000000000000000000000000000002', otherCoordinator, 700)
      const crawled: unknown[] = []
      sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').callsFake(async function (this: any): Promise<undefined> {
        if (this.crawlSetting.filter.fromBlock === 500) throw new Error('rpc')
        crawled.push(this.crawlSetting.filter.address)
        return undefined
      })
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()

      await LogInterfold.start(network)

      expect(crawled).to.deep.equal([[otherCoordinator]])
    })
  })

  describe('queue', () => {
    it('should store the coordinator of the plugin and queue the crawl of its network', async () => {
      const plugin = await createPlugin('0x1000000000000000000000000000000000000001', undefined, 500)
      const ensureStub = sandbox.stub(CrispInterfoldHandler, 'ensureInterfold').resolves(coordinator as any)
      const sendMessageStub = sandbox.stub(RabbitMQHelper, 'sendMessage').resolves()

      await LogInterfold.queue(plugin)

      expect(ensureStub.calledOnceWith(plugin)).to.be.true
      expect(sendMessageStub.calledOnceWith(EnumQueueName.logInterfold, { id: network, params: { network } })).to.be
        .true
    })

    it('should not throw when the coordinator cannot be read', async () => {
      const plugin = await createPlugin('0x1000000000000000000000000000000000000001', undefined, 500)
      sandbox.stub(CrispInterfoldHandler, 'ensureInterfold').rejects(new Error('rpc'))
      const sendMessageStub = sandbox.stub(RabbitMQHelper, 'sendMessage').resolves()

      await LogInterfold.queue(plugin)

      expect(sendMessageStub.called).to.be.false
    })
  })
})
