import { Models } from '@dbModels'
import { GovernanceBondedVotesHandler } from '@handlers/governanceBondedVotesHandler'
import GovernanceBondedVotesHelper from '@helpers/governanceBondedVotes'
import RabbitMQHelper from '@helpers/rabbitMQ'
import Web3Helper from '@helpers/web3'
import logger from '@logger'
import { BlockchainLogCrawler } from '@modules/crawlers'
import { LogTokenVoting } from '@plugins/logTokenVoting'
import {
  EnumQueueName,
  IBondedVotesLogs,
  IGovernanceErc20Logs,
  IPluginInterfaceType,
  IPluginStatus,
  ITokenType,
  IVotingEscrowAdapterLogs,
  IVotingEscrowIncreasingLogs,
  NetworksEnum,
} from '@types'
import { expect } from 'chai'
import proxyquire from 'proxyquire'
import * as sinon from 'sinon'
import { SinonSandbox } from 'sinon'

describe('AragonPlugins: LogTokenVoting', () => {
  let sandbox: SinonSandbox

  beforeEach(async () => {
    sandbox = sinon.createSandbox()
    sandbox.stub(Web3Helper, 'getBlockNumber').resolves()
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('start', async () => {
    it('should start veGovernance flow for escrowAdapter token type', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const verboseStub = sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.escrowAdapter,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
          exitQueueAddress: '0xExitQueueAddress',
        },
      } as any

      await LogTokenVoting.start(plugin, token)

      expect(crawlStub.callCount).to.equal(2) // plugin and veGovernance crawlers
      expect(verboseStub.calledWith('Start LogTokenVoting veGovernance' as any)).to.be.true
      expect(verboseStub.calledWith('End LogTokenVoting veGovernance' as any)).to.be.true
    })

    it('should start erc20Governance flow for ERC20 token type', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const verboseStub = sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
        blockNumber: 100,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        blockNumber: 200,
      } as any

      await LogTokenVoting.start(plugin, token)

      expect(crawlStub.calledTwice).to.be.true // Both plugin and token crawlers
      expect(verboseStub.calledWith('Start LogTokenVoting' as any)).to.be.true
      expect(verboseStub.calledWith('End LogTokenVoting' as any)).to.be.true
    })

    it('should pass isHistorical flag to crawlers', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
      } as any

      await LogTokenVoting.start(plugin, token, true) // Pass isHistorical = true

      expect(crawlStub.calledTwice).to.be.true
    })
  })

  describe('erc20Governance', () => {
    it('should handle standard flow when token is eligible for sync', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const verboseStub = sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
        blockNumber: 100,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        blockNumber: 200,
      } as any

      await LogTokenVoting.erc20Governance(plugin, token)

      expect(crawlStub.calledTwice).to.be.true // Both plugin and token crawlers
      expect(verboseStub.calledWith('Start LogTokenVoting' as any)).to.be.true
      expect(verboseStub.calledWith('Start Token Sync' as any)).to.be.true
      expect(verboseStub.calledWith('End LogTokenVoting' as any)).to.be.true
    })

    it('should return items unchanged when event is not DelegateVotesChanged', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
        blockNumber: 100,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        blockNumber: 200,
        interfaceType: 'tokenVoting',
      } as any

      await LogTokenVoting.erc20Governance(plugin, token)

      expect(crawlStub.calledTwice).to.be.true
    })

    it('should return items unchanged when plugin has no tokenAddress', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
        blockNumber: 100,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        blockNumber: 200,
        interfaceType: 'tokenVoting',
      } as any

      await LogTokenVoting.erc20Governance(plugin, token)

      expect(crawlStub.calledTwice).to.be.true
    })

    it('should handle errors during plugin crawling', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      sandbox.stub(logger, 'verbose')
      const error = new Error('Test error from plugin crawler')

      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      crawlStub.onFirstCall().callsFake(async function (this: BlockchainLogCrawler): Promise<any> {
        if ((this as any).crawlParams.onError) {
          await (this as any).crawlParams.onError(error, { logIndex: 1, transactionHash: '0xhash1' })
        }
      })
      crawlStub.onSecondCall().resolves()

      const processErrorStub = sandbox.stub(LogTokenVoting, 'processError').resolves()

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(crawlStub.calledTwice).to.be.true
      expect(processErrorStub.calledOnce).to.be.true
      expect(processErrorStub.calledWith(error, pluginStub, { logIndex: 1, transactionHash: '0xhash1' })).to.be.true
    })

    it('should handle errors during token crawling', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      const error = new Error('Test error from token crawler')
      sandbox.stub(logger, 'verbose')

      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: BlockchainLogCrawler): Promise<any> {
        if ((this as any).crawlParams.onError) {
          await (this as any).crawlParams.onError(error, { logIndex: 2, transactionHash: '0xhash2' })
        }
      })

      const processErrorStub = sandbox.stub(LogTokenVoting, 'processError').resolves()

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(crawlStub.calledTwice).to.be.true
      expect(processErrorStub.calledOnce).to.be.true
      expect(processErrorStub.calledWith(error, pluginStub, { logIndex: 2, transactionHash: '0xhash2' })).to.be.true
    })

    it('should use tokenCrawler when token has no existing sync block', async () => {
      // Setup
      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
        blockNumber: 100,
      } as any

      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        blockNumber: 200,
        interfaceType: 'tokenVoting',
      } as any

      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')

      // Act
      await LogTokenVoting.erc20Governance(plugin, token)

      // Assert
      expect(crawlStub.calledTwice).to.be.true
    })

    it('should filter logs returning empty array when no logs provided', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      sandbox.stub(logger, 'verbose')

      let capturedFilterLogs: any
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()

      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: any): Promise<undefined> {
        if (this.crawlParams?.filterLogs) {
          capturedFilterLogs = this.crawlParams.filterLogs
          await capturedFilterLogs([])
        }
        return undefined
      })

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(capturedFilterLogs).to.not.be.undefined
    })

    it('should filter duplicate DelegateVotesChanged logs keeping highest block number', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      sandbox.stub(logger, 'verbose')

      let result: any
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()

      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: any) {
        if (this.crawlParams?.filterLogs) {
          const logs = [
            { topics: ['0xevent', '0xdelegate1'], blockNumber: 100n },
            { topics: ['0xevent', '0xdelegate2'], blockNumber: 101n },
            { topics: ['0xevent', '0xdelegate1'], blockNumber: 102n },
            { topics: ['0xevent', '0xdelegate3'], blockNumber: 103n },
            { topics: ['0xevent', '0xdelegate2'], blockNumber: 99n },
          ]
          result = await this.crawlParams.filterLogs(logs)
        }
        return undefined
      })

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(result).to.have.length(3)
      expect(result[0].topics[1]).to.equal('0xdelegate3')
      expect(result[1].topics[1]).to.equal('0xdelegate1')
      expect(result[2].topics[1]).to.equal('0xdelegate2')
    })

    it('should keep the highest log index for duplicate DelegateVotesChanged logs in the same block', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      sandbox.stub(logger, 'verbose')

      let result: any
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()

      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: any) {
        if (this.crawlParams?.filterLogs) {
          const logs = [
            { topics: ['0xevent', '0xdelegate1'], blockNumber: 100n, index: 5, newBalance: '100' },
            { topics: ['0xevent', '0xdelegate1'], blockNumber: 100n, index: 8, newBalance: '0' },
          ]
          result = await this.crawlParams.filterLogs(logs)
        }
        return undefined
      })

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(result).to.have.length(1)
      expect(result[0].index).to.equal(8)
      expect(result[0].newBalance).to.equal('0')
    })

    it('should log filtered results with correct counts', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      const verboseStub = sandbox.stub(logger, 'verbose')

      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: any) {
        if (this.crawlParams?.filterLogs) {
          const logs = [
            { topics: ['0xevent', '0xdelegate1'], blockNumber: 100n },
            { topics: ['0xevent', '0xdelegate1'], blockNumber: 102n },
            { topics: ['0xevent', '0xdelegate2'], blockNumber: 101n },
          ]
          await this.crawlParams.filterLogs(logs)
        }
        return undefined
      })

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(verboseStub.calledWith('Filtered DelegateVotesChanged logs' as any)).to.be.true
    })

    it('should handle filterLogs with single log', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      sandbox.stub(logger, 'verbose')

      let result: any
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: any) {
        if (this.crawlParams?.filterLogs) {
          const logs = [{ topics: ['0xevent', '0xdelegate1'], blockNumber: 100n }]
          result = await this.crawlParams.filterLogs(logs)
        }
        return undefined
      })

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(result).to.have.length(1)
      expect(result[0].topics[1]).to.equal('0xdelegate1')
    })

    it('should handle filterLogs sorting by blockNumber descending', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      sandbox.stub(logger, 'verbose')

      let result: any
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: any) {
        if (this.crawlParams?.filterLogs) {
          const logs = [
            { topics: ['0xevent', '0xdelegate1'], blockNumber: 50n },
            { topics: ['0xevent', '0xdelegate2'], blockNumber: 150n },
            { topics: ['0xevent', '0xdelegate3'], blockNumber: 100n },
          ]
          result = await this.crawlParams.filterLogs(logs)
        }
        return []
      })

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(result).to.have.length(3)
      expect(Number(result[0].blockNumber)).to.be.greaterThan(Number(result[1].blockNumber))
      expect(Number(result[1].blockNumber)).to.be.greaterThan(Number(result[2].blockNumber))
    })

    it('should remove all duplicates keeping only highest blockNumber per delegate', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      sandbox.stub(logger, 'verbose')

      let result: any
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      crawlStub.onFirstCall().resolves()
      crawlStub.onSecondCall().callsFake(async function (this: any) {
        if (this.crawlParams?.filterLogs) {
          const logs = [
            { topics: ['0xevent', '0xdelegateA'], blockNumber: 100n },
            { topics: ['0xevent', '0xdelegateA'], blockNumber: 200n },
            { topics: ['0xevent', '0xdelegateA'], blockNumber: 150n },
            { topics: ['0xevent', '0xdelegateB'], blockNumber: 300n },
            { topics: ['0xevent', '0xdelegateB'], blockNumber: 250n },
          ]
          result = await this.crawlParams.filterLogs(logs)
        }
        return []
      })

      await LogTokenVoting.erc20Governance(pluginStub, tokenStub)

      expect(result).to.have.length(2)
      const delegateALog = result.find((r: any) => r.topics[1] === '0xdelegateA')
      const delegateBLog = result.find((r: any) => r.topics[1] === '0xdelegateB')

      expect(delegateALog.blockNumber).to.equal(200n)
      expect(delegateBLog.blockNumber).to.equal(300n)
    })

    it('should properly map config items based on event type', async () => {
      const mockConfigIndexer = [
        {
          event: 'DelegateVotesChanged',
          config: [{ handler: 'original-handler-1', validator: 'validator-1' }],
        },
        {
          event: 'OtherGovernanceEvent',
          config: [{ handler: 'original-handler-2', validator: 'validator-2' }],
        },
      ]

      let tokenCrawlerConfig: any = null
      let crawlerCount = 0
      const BlockchainLogCrawlerMock = function (this: any, config: any) {
        // Capture the second crawler (tokenCrawler)
        crawlerCount++
        if (crawlerCount === 2) {
          tokenCrawlerConfig = config
        }
        this.crawl = sandbox.stub().resolves()
        this.end = sandbox.stub().resolves()
        this.crawlSetting = { lastSync: 1000 }
      }

      const GovernanceErc20HandlerMock = {
        delegateVotesChangedBatch: 'batch-handler',
      }

      // Mock IGovernanceErc20Logs to have multiple values
      const mockGovernanceErc20Logs = {
        DelegateVotesChanged: 'DelegateVotesChanged',
        OtherGovernanceEvent: 'OtherGovernanceEvent',
      }

      const LogTokenVotingProxy = proxyquire('@plugins/logTokenVoting', {
        '@logger': { default: logger },
        '@indexer/configIndexer': { default: mockConfigIndexer },
        '@modules/crawlers': { BlockchainLogCrawler: BlockchainLogCrawlerMock },
        '@handlers/governanceErc20Handler': { GovernanceErc20Handler: GovernanceErc20HandlerMock },
        '@types': {
          IGovernanceErc20Logs: mockGovernanceErc20Logs,
          NetworksEnum: NetworksEnum,
          ITokenType: ITokenType,
        },
      }).LogTokenVoting

      sandbox.stub(logger, 'verbose')

      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      await LogTokenVotingProxy.erc20Governance(pluginStub, tokenStub)

      // Verify tokenCrawler config was captured
      expect(tokenCrawlerConfig).to.not.be.null
      expect(tokenCrawlerConfig.events).to.have.length(2)

      // Find the DelegateVotesChanged event - should have modified handler
      const delegateVotesChangedEvent = tokenCrawlerConfig.events.find((e: any) => e.event === 'DelegateVotesChanged')
      expect(delegateVotesChangedEvent).to.exist
      expect(delegateVotesChangedEvent.config[0].handler).to.equal('batch-handler')

      const otherEvent = tokenCrawlerConfig.events.find((e: any) => e.event === 'OtherGovernanceEvent')
      expect(otherEvent).to.exist
      expect(otherEvent.config[0].handler).to.equal('original-handler-2')
    })

    it('should execute filterLogs function with various log scenarios', async () => {
      let capturedFilterLogs: any = null
      let crawlerCount = 0
      const BlockchainLogCrawlerMock = function (this: any, config: any) {
        // Capture filterLogs from second crawler (tokenCrawler)
        crawlerCount++
        if (crawlerCount === 2 && config.filterLogs) {
          capturedFilterLogs = config.filterLogs
        }
        this.crawl = sandbox.stub().resolves()
        this.end = sandbox.stub().resolves()
        this.crawlSetting = { lastSync: 1000 }
      }

      const mockConfigIndexer = [
        {
          event: IGovernanceErc20Logs.DelegateVotesChanged,
          config: [{ handler: 'handler', validator: 'validator' }],
        },
      ]

      const LogTokenVotingProxy = proxyquire('@plugins/logTokenVoting', {
        '@logger': { default: logger },
        '@indexer/configIndexer': { default: mockConfigIndexer },
        '@modules/crawlers': { BlockchainLogCrawler: BlockchainLogCrawlerMock },
      }).LogTokenVoting

      const verboseStub = sandbox.stub(logger, 'verbose')

      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        blockNumber: 100,
        interfaceType: 'tokenVoting',
      } as any

      const tokenStub = {
        address: '0x456',
        blockNumber: 200,
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.ERC20,
      } as any

      await LogTokenVotingProxy.erc20Governance(pluginStub, tokenStub)

      expect(capturedFilterLogs).to.not.be.null

      const emptyResult = await capturedFilterLogs([])
      expect(emptyResult).to.deep.equal([])

      const logsWithDuplicates = [
        { topics: ['0xevent', '0xdelegate1'], blockNumber: 100n },
        { topics: ['0xevent', '0xdelegate2'], blockNumber: 101n },
        { topics: ['0xevent', '0xdelegate1'], blockNumber: 102n }, // duplicate, higher block
        { topics: ['0xevent', '0xdelegate3'], blockNumber: 103n },
        { topics: ['0xevent', '0xdelegate2'], blockNumber: 99n }, // duplicate, lower block
      ]

      const filteredResult = await capturedFilterLogs(logsWithDuplicates)

      // Should keep highest block numbers for each delegate
      expect(filteredResult).to.have.length(3)
      expect(filteredResult[0].topics[1]).to.equal('0xdelegate3') // block 103
      expect(filteredResult[1].topics[1]).to.equal('0xdelegate1') // block 102 (not 100)
      expect(filteredResult[2].topics[1]).to.equal('0xdelegate2') // block 101 (not 99)

      expect(verboseStub.calledWith('Filtered DelegateVotesChanged logs' as any)).to.be.true

      // Test 3: Single log (no duplicates)
      verboseStub.resetHistory()
      const singleLog = [{ topics: ['0xevent', '0xdelegate1'], blockNumber: 100n }]
      const singleResult = await capturedFilterLogs(singleLog)
      expect(singleResult).to.have.length(1)
      expect(singleResult[0].topics[1]).to.equal('0xdelegate1')

      // Verify logging for single log
      expect(verboseStub.calledWith('Filtered DelegateVotesChanged logs' as any)).to.be.true
    })
  })

  describe('veGovernance', () => {
    it('should handle veGovernance path with proper crawlers', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const verboseStub = sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.escrowAdapter,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
          exitQueueAddress: '0xExitQueueAddress',
        },
        interfaceType: 'tokenVoting',
        blockNumber: 100,
      } as any

      await LogTokenVoting.veGovernance(plugin, token)

      expect(crawlStub.callCount).to.equal(2) // plugin and veGovernance crawlers
      expect(verboseStub.calledWith('Start LogTokenVoting veGovernance' as any)).to.be.true
      expect(verboseStub.calledWith('Start Token Sync' as any)).to.be.true
      expect(verboseStub.calledWith('End LogTokenVoting veGovernance' as any)).to.be.true
    })

    it('should handle errors from veGovernance crawlers', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        interfaceType: 'tokenVoting',
        blockNumber: 100,
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
          exitQueueAddress: '0xExitQueueAddress',
        },
      } as any

      const tokenStub = {
        address: '0x456',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.escrowAdapter,
      } as any

      sandbox.stub(logger, 'verbose')
      const error = new Error('Test error from veGovernance crawler')

      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      crawlStub.onCall(0).resolves() // plugin crawler
      crawlStub.onCall(1).callsFake(async function (this: BlockchainLogCrawler): Promise<any> {
        if ((this as any).crawlParams.onError) {
          await (this as any).crawlParams.onError(error, { logIndex: 4, transactionHash: '0xhash4' })
        }
      })

      const processErrorStub = sandbox.stub(LogTokenVoting, 'processError').resolves()

      await LogTokenVoting.veGovernance(pluginStub, tokenStub)

      expect(crawlStub.callCount).to.equal(2)
      expect(processErrorStub.calledOnce).to.be.true
      expect(processErrorStub.calledWith(error, pluginStub, { logIndex: 4, transactionHash: '0xhash4' })).to.be.true
    })

    it('should pass isHistorical flag to veGovernance crawlers', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const verboseStub = sandbox.stub(logger, 'verbose')

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.escrowAdapter,
      } as any
      const plugin = {
        address: '0x123',
        tokenAddress: token.address,
        network: token.network,
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
          exitQueueAddress: '0xExitQueueAddress',
        },
      } as any

      await LogTokenVoting.veGovernance(plugin, token, true) // Pass isHistorical = true

      expect(crawlStub.callCount).to.equal(2)
      expect(verboseStub.calledWith('Start LogTokenVoting veGovernance' as any)).to.be.true
    })

    it('should handle error from plugin crawler in veGovernance', async () => {
      const pluginStub = {
        address: '0x123',
        tokenAddress: '0x456',
        network: NetworksEnum.ethereumSepolia,
        interfaceType: 'tokenVoting',
        blockNumber: 100,
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
          exitQueueAddress: '0xExitQueueAddress',
        },
      } as any

      const tokenStub = {
        address: '0x456',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.escrowAdapter,
        blockNumber: 50,
      } as any

      sandbox.stub(logger, 'verbose')
      const error = new Error('Plugin crawler error in veGovernance')

      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl')
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      // First call is plugin crawler - trigger onError
      crawlStub.onFirstCall().callsFake(async function (this: BlockchainLogCrawler): Promise<any> {
        if ((this as any).crawlParams.onError) {
          await (this as any).crawlParams.onError(error, { logIndex: 5, transactionHash: '0xhash5' })
        }
      })
      // Second call is veGovernance crawler
      crawlStub.onSecondCall().resolves()

      const processErrorStub = sandbox.stub(LogTokenVoting, 'processError').resolves()

      await LogTokenVoting.veGovernance(pluginStub, tokenStub)

      expect(crawlStub.callCount).to.equal(2)
      expect(processErrorStub.calledOnce).to.be.true
      expect(processErrorStub.calledWith(error, pluginStub, { logIndex: 5, transactionHash: '0xhash5' })).to.be.true
    })

    it('should not crawl the token without a voting escrow, which would key the crawl on `undefined`', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')
      const escrowCrawlerStub = sandbox.spy(LogTokenVoting, 'buildEscrowCrawler')

      const token = { address: '0x123', network: NetworksEnum.ethereumSepolia, type: ITokenType.escrowAdapter } as any
      const plugin = { address: '0x456', tokenAddress: token.address, network: token.network } as any

      await LogTokenVoting.veGovernance(plugin, token)

      expect(crawlStub.calledOnce).to.be.true
      expect(escrowCrawlerStub.called).to.be.false
    })
  })

  describe('bondedVotesGovernance', () => {
    const token = {
      address: '0xBondedVotes',
      network: NetworksEnum.ethereumSepolia,
      type: ITokenType.bondedVotes,
      blockNumber: 50,
    } as any
    const plugin = {
      address: '0x456',
      tokenAddress: token.address,
      network: token.network,
      blockNumber: 100,
      status: IPluginStatus.installed,
    } as any
    const sources = { checkpoints: '0xCheckpoints', votesSource: '0xVotesSource', escrow: '0xEscrow' }
    const startBlock = 20
    let sendDelayedMessageStub: sinon.SinonStub

    beforeEach(() => {
      sandbox.stub(GovernanceBondedVotesHelper, 'getSources').resolves(sources)
      sandbox.stub(GovernanceBondedVotesHelper, 'getStartBlock').resolves(startBlock)
      sendDelayedMessageStub = sandbox.stub(RabbitMQHelper, 'sendDelayedMessage').resolves()
    })

    it('should crawl the BondedVotes events from the token, checkpoints, votes source and escrow', async () => {
      const crawler = await LogTokenVoting.buildBondedVotesCrawler(plugin, token)
      const { address, events, logService } = (crawler as any).crawlParams

      expect(address).to.deep.equal([token.address, sources.checkpoints, sources.votesSource, sources.escrow])
      expect(logService).to.equal(`bondedVotes-${token.network}-${token.address}`)
      expect(events.map((item: any) => item.event)).to.have.members([
        IBondedVotesLogs.BondedDelegateChanged,
        IBondedVotesLogs.BondedCheckpointed,
        IGovernanceErc20Logs.DelegateVotesChanged,
        IVotingEscrowAdapterLogs.DelegateChanged,
        IVotingEscrowAdapterLogs.TokensDelegated,
        IVotingEscrowAdapterLogs.TokensUndelegated,
        IVotingEscrowIncreasingLogs.Deposit,
        IVotingEscrowIncreasingLogs.Withdraw,
      ])
    })

    it('should start from the first block of the contracts it reads, not the token or the plugin block', async () => {
      const crawler = await LogTokenVoting.buildBondedVotesCrawler(plugin, token)

      expect((crawler as any).crawlParams.fromBlock).to.equal(startBlock)
      expect(startBlock).to.be.lessThan(token.blockNumber)
      expect(startBlock).to.be.lessThan(plugin.blockNumber)
    })

    it('should not look for the first block of the contracts once the crawl has progress', async () => {
      await Models.ConfigIndexer.create({
        network: token.network,
        service: `${ITokenType.bondedVotes}-${token.network}-${token.address}` as any,
        lastSync: 1000,
      })

      const crawler = await LogTokenVoting.buildBondedVotesCrawler(plugin, token)

      expect((GovernanceBondedVotesHelper.getStartBlock as sinon.SinonStub).called).to.be.false
      expect(await (crawler as any).getServiceStartBlock()).to.deep.equal({ block: 1000, isExisting: true })
    })

    it('should refresh voting power through handlers bound to the token, never the global ones', async () => {
      const crawler = await LogTokenVoting.buildBondedVotesCrawler(plugin, token)
      const { events } = (crawler as any).crawlParams
      const globalHandlers = Object.values(GovernanceBondedVotesHandler).filter(h => typeof h === 'function')

      for (const event of events) {
        event.config.forEach((cfg: any) => {
          expect(globalHandlers).to.not.include(cfg.handler)
          expect(globalHandlers).to.not.include(cfg.batchHandler)
          expect(cfg.handler).to.be.a('function')
        })
      }
    })

    it('should dedupe the crawled addresses when the votes source is the token itself', async () => {
      ;(GovernanceBondedVotesHelper.getSources as sinon.SinonStub).resolves({
        checkpoints: '0xCheckpoints',
        votesSource: token.address,
        escrow: null,
      })

      const crawler = await LogTokenVoting.buildBondedVotesCrawler(plugin, token)

      expect((crawler as any).crawlParams.address).to.deep.equal([token.address, '0xCheckpoints'])
    })

    it('should still sync the plugin, and queue it again, when the bonded crawler cannot be built', async () => {
      ;(GovernanceBondedVotesHelper.getSources as sinon.SinonStub).rejects(new Error('execution reverted'))
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      const endStub = sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')
      const warnStub = sandbox.stub(logger, 'warn')

      await LogTokenVoting.start(plugin, token)

      expect(crawlStub.calledOnce).to.be.true
      expect(endStub.calledOnce).to.be.true
      expect(warnStub.calledOnce).to.be.true
      expect(sendDelayedMessageStub.calledOnce).to.be.true
      const [queueName, payload, delayMs] = sendDelayedMessageStub.firstCall.args
      expect(queueName).to.equal(EnumQueueName.plugins)
      expect(payload).to.deep.equal({
        id: `${plugin.network}-${plugin.address}`,
        params: { address: plugin.address, network: plugin.network, isHistorical: undefined, attempt: 1 },
      })
      expect(delayMs).to.equal(60_000)
    })

    describe('retrying a build that keeps failing', () => {
      let errorStub: sinon.SinonStub

      beforeEach(() => {
        ;(GovernanceBondedVotesHelper.getSources as sinon.SinonStub).rejects(new Error('execution reverted'))
        sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
        sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
        sandbox.stub(logger, 'verbose')
        sandbox.stub(logger, 'warn')
        errorStub = sandbox.stub(logger, 'error')
      })

      const retryDelays = async (attempts: number[]) => {
        const delays: number[] = []
        for (const attempt of attempts) {
          sendDelayedMessageStub.resetHistory()
          await LogTokenVoting.start(plugin, token, undefined, attempt)
          delays.push(sendDelayedMessageStub.firstCall.args[2])
        }
        return delays
      }

      it('should carry the next attempt and double the delay each time', async () => {
        expect(await retryDelays([0, 1, 2])).to.deep.equal([60_000, 120_000, 240_000])

        await LogTokenVoting.start(plugin, token, undefined, 2)
        expect(sendDelayedMessageStub.firstCall.args[1].params.attempt).to.equal(3)
      })

      it('should cap the delay', async () => {
        const [delay] = await retryDelays([7])

        expect(delay).to.equal(30 * 60 * 1000)
      })

      it('should give up, and log an error, after the last retry', async () => {
        await retryDelays([7])
        sendDelayedMessageStub.resetHistory()
        errorStub.resetHistory()

        await LogTokenVoting.start(plugin, token, undefined, 8)

        expect(sendDelayedMessageStub.called).to.be.false
        expect(errorStub.calledOnce).to.be.true
        expect(errorStub.firstCall.args[0]).to.include('giving up')
      })

      it('should not retry for a plugin that is no longer installed', async () => {
        await LogTokenVoting.start({ ...plugin, status: IPluginStatus.uninstalled }, token, undefined, 0)

        expect(sendDelayedMessageStub.called).to.be.false
      })
    })

    describe('when the retry is queued', () => {
      let steps: string[]

      beforeEach(() => {
        ;(GovernanceBondedVotesHelper.getSources as sinon.SinonStub).rejects(new Error('execution reverted'))
        sandbox.stub(logger, 'verbose')
        sandbox.stub(logger, 'warn')
        steps = []
        sendDelayedMessageStub.callsFake(async () => {
          steps.push('retry')
        })
        sandbox.stub(BlockchainLogCrawler.prototype, 'end').callsFake(async () => {
          steps.push('end')
        })
      })

      it('should only queue the retry after the crawls have finished, or it can arrive as a duplicate of this job', async () => {
        sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').callsFake(async () => {
          steps.push('crawl')
          return []
        })

        await LogTokenVoting.start(plugin, token)

        expect(steps).to.deep.equal(['crawl', 'end', 'retry'])
      })

      it('should not queue the retry when the plugin crawl fails, as it would be dropped as a duplicate of this job', async () => {
        sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').rejects(new Error('rpc down'))

        await expect(LogTokenVoting.start(plugin, token)).to.be.rejectedWith('rpc down')

        expect(steps).to.deep.equal([])
      })
    })

    it('should still sync the plugin, and queue it again, when the first block of the contracts cannot be found', async () => {
      ;(GovernanceBondedVotesHelper.getStartBlock as sinon.SinonStub).rejects(new Error('No contract code'))
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')
      sandbox.stub(logger, 'warn')

      await LogTokenVoting.start(plugin, token, true)

      expect(crawlStub.calledOnce).to.be.true
      expect(sendDelayedMessageStub.calledOnce).to.be.true
      expect(sendDelayedMessageStub.firstCall.args[1].params.isHistorical).to.be.true
    })

    it('should not queue the plugin again when the bonded crawler is built', async () => {
      sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')

      await LogTokenVoting.start(plugin, token)

      expect(sendDelayedMessageStub.called).to.be.false
    })

    it('should crawl the plugin and the token', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')

      await LogTokenVoting.start(plugin, token)

      expect(crawlStub.calledTwice).to.be.true
    })
  })

  describe('buildPluginCrawler', () => {
    const crawledEvents = (interfaceType: IPluginInterfaceType) => {
      const plugin = { address: '0x456', network: NetworksEnum.ethereumSepolia, interfaceType } as any
      const { events } = (LogTokenVoting.buildPluginCrawler(plugin) as any).crawlParams
      return events.map((item: any) => item.event)
    }

    it('should crawl the E3 settings and no ballots for a crisp plugin', () => {
      const events = crawledEvents(IPluginInterfaceType.crisp)

      expect(events).to.include('E3SettingsUpdated')
      expect(events).to.not.include('VoteCast')
    })

    it('should crawl the ballots and no E3 settings for a token voting plugin', () => {
      const events = crawledEvents(IPluginInterfaceType.tokenVoting)

      expect(events).to.include('VoteCast')
      expect(events).to.not.include('E3SettingsUpdated')
    })
  })

  describe('runEscrowCrawler', () => {
    it('should build escrow crawler and run crawl and end', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      const endStub = sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.escrowAdapter,
        blockNumber: 100,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        blockNumber: 200,
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
          exitQueueAddress: '0xExitQueueAddress',
        },
      } as any

      await LogTokenVoting.runEscrowCrawler(plugin, token, false)

      expect(crawlStub.calledOnce).to.be.true
      expect(endStub.calledOnce).to.be.true
    })

    it('should pass isHistorical flag to escrow crawler', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      const endStub = sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()

      const token = {
        address: '0x123',
        network: NetworksEnum.ethereumSepolia,
        type: ITokenType.escrowAdapter,
      } as any
      const plugin = {
        address: '0x456',
        tokenAddress: token.address,
        network: token.network,
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
          exitQueueAddress: '0xExitQueueAddress',
        },
      } as any

      await LogTokenVoting.runEscrowCrawler(plugin, token, true)

      expect(crawlStub.calledOnce).to.be.true
      expect(endStub.calledOnce).to.be.true
    })

    it('should log warning and skip crawl when votingEscrow is missing', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      const endStub = sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const warnStub = sandbox.stub(logger, 'warn')

      const token = { address: '0x123' } as any
      const plugin = {
        address: '0x456',
        votingEscrow: null,
      } as any

      await LogTokenVoting.runEscrowCrawler(plugin, token, false)

      expect(crawlStub.notCalled).to.be.true
      expect(endStub.notCalled).to.be.true
      expect(warnStub.calledWith('LogTokenVoting: runEscrowCrawler - missing votingEscrow or token' as any)).to.be.true
    })

    it('should log warning and skip crawl when token is null', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      const endStub = sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const warnStub = sandbox.stub(logger, 'warn')

      const plugin = {
        address: '0x456',
        votingEscrow: {
          escrowAddress: '0xEscrowAddress',
        },
      } as any

      await LogTokenVoting.runEscrowCrawler(plugin, null as any, false)

      expect(crawlStub.notCalled).to.be.true
      expect(endStub.notCalled).to.be.true
      expect(warnStub.calledWith('LogTokenVoting: runEscrowCrawler - missing votingEscrow or token' as any)).to.be.true
    })
  })

  describe('processError', () => {
    it('should log error with complete details', async () => {
      const errorStub = sandbox.stub(logger, 'error')
      const error = new Error('Test error')
      const plugin = {
        address: '0x123',
        tokenAddress: '0xtoken',
        network: NetworksEnum.ethereumSepolia,
      } as any
      const log = { logIndex: 1, transactionHash: '0xhash' }

      await LogTokenVoting.processError(error, plugin, log)

      expect(errorStub.calledOnce).to.be.true
      expect(errorStub.calledWith('Error LogTokenVoting' as any)).to.be.true
    })

    it('should handle processError with string error', async () => {
      const errorStub = sandbox.stub(logger, 'error')
      await LogTokenVoting.processError(
        'string error',
        {
          address: '0x123',
          tokenAddress: '0xtoken',
          network: NetworksEnum.ethereumSepolia,
        } as any,
        'log',
      )
      expect(errorStub.calledOnce).to.be.true
      expect(errorStub.calledWith('Error LogTokenVoting' as any)).to.be.true
    })
  })
})
