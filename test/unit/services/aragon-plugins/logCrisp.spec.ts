import logger from '@logger'
import { BlockchainLogCrawler } from '@modules/crawlers'
import { LogCrisp } from '@plugins/logCrisp'
import { LogTokenVoting } from '@plugins/logTokenVoting'
import configIndexer from '@services/aragon-indexer/configIndexer'
import { ICrispVotingLogs, IPluginInterfaceType, ITokenType, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox } from 'sinon'

describe('AragonPlugins: LogCrisp', () => {
  let sandbox: SinonSandbox

  const plugin = {
    address: '0x123',
    network: NetworksEnum.ethereumSepolia,
    daoAddress: '0xdao',
    blockNumber: 100,
    interfaceType: IPluginInterfaceType.crisp,
    tokenAddress: '0xtoken',
  } as any

  const token = {
    address: '0xtoken',
    network: NetworksEnum.ethereumSepolia,
    type: ITokenType.ERC20,
    blockNumber: 50,
  } as any

  // BondedVotes: typed escrowAdapter by the token detector, no escrow behind it.
  const bondedToken = { ...token, type: ITokenType.escrowAdapter } as any
  const escrowPlugin = {
    ...plugin,
    votingEscrow: { escrowAddress: '0xescrow', exitQueueAddress: '0xqueue' },
  } as any

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('start', () => {
    it('should crawl both the plugin and its governance token', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      const endStub = sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      const verboseStub = sandbox.stub(logger, 'verbose')

      await LogCrisp.start(plugin, token)

      expect(crawlStub.calledTwice).to.be.true
      expect(endStub.calledTwice).to.be.true
      expect(verboseStub.calledWith('Start LogCrisp' as any)).to.be.true
    })

    it('should route crawler errors through processError', async () => {
      const error = new Error('crawler test error')
      let crawlCallCount = 0

      sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').callsFake(async function (
        this: BlockchainLogCrawler,
      ): Promise<any> {
        crawlCallCount++
        if (crawlCallCount === 1 && (this as any).crawlParams.onError) {
          await (this as any).crawlParams.onError(error, { logIndex: 1, transactionHash: '0xhash' })
        }
      })
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')
      const processErrorStub = sandbox.stub(LogCrisp, 'processError').resolves()

      await LogCrisp.start(plugin, token)

      expect(processErrorStub.calledOnce).to.be.true
    })

    it('should crawl only the plugin for an escrow-adapter token without an escrow (BondedVotes)', async () => {
      // BondedVotes emits neither DelegateVotesChanged nor the voting-escrow adapter events and
      // plugin.votingEscrow is unset, so a token crawler would be a no-op keyed on `undefined`.
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      const endStub = sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')
      const escrowCrawlerStub = sandbox.stub(LogTokenVoting, 'buildEscrowCrawler')
      const tokenCrawlerStub = sandbox.stub(LogCrisp, 'buildTokenCrawler')

      await LogCrisp.start(plugin, bondedToken)

      expect(crawlStub.calledOnce).to.be.true
      expect(endStub.calledOnce).to.be.true
      expect(escrowCrawlerStub.called).to.be.false
      expect(tokenCrawlerStub.called).to.be.false
    })

    it('should crawl the escrow adapter events when the token has a voting escrow', async () => {
      const crawlStub = sandbox.stub(BlockchainLogCrawler.prototype, 'crawl').resolves()
      sandbox.stub(BlockchainLogCrawler.prototype, 'end').resolves()
      sandbox.stub(logger, 'verbose')
      const escrowCrawler = {
        crawl: sandbox.stub().resolves(),
        end: sandbox.stub().resolves(),
        crawlSetting: { lastSync: 0 },
      }
      const escrowCrawlerStub = sandbox.stub(LogTokenVoting, 'buildEscrowCrawler').returns(escrowCrawler as any)
      const tokenCrawlerStub = sandbox.stub(LogCrisp, 'buildTokenCrawler')

      await LogCrisp.start(escrowPlugin, bondedToken, true)

      expect(escrowCrawlerStub.calledOnceWith(escrowPlugin, bondedToken, true)).to.be.true
      expect(tokenCrawlerStub.called).to.be.false
      expect(crawlStub.calledOnce).to.be.true
      expect(escrowCrawler.crawl.calledOnce).to.be.true
      expect(escrowCrawler.end.calledOnce).to.be.true
    })
  })

  describe('buildPluginCrawler', () => {
    it('should crawl the proposal and settings events of the plugin', () => {
      const crawler = LogCrisp.buildPluginCrawler(plugin)
      const events = (crawler as any).crawlParams.events.map((item: any) => item.event)

      expect(events).to.include(ICrispVotingLogs.ProposalCreated)
      expect(events).to.include(ICrispVotingLogs.ProposalExecuted)
      expect(events).to.include(ICrispVotingLogs.MetadataSet)
      expect(events).to.include(ICrispVotingLogs.E3SettingsUpdated)
      expect(events).to.include(ICrispVotingLogs.VotingSettingsUpdated)
    })

    it('should not crawl VoteCast, which an encrypted proposal never emits', () => {
      // A CRISP ballot goes to the E3 round, not to the plugin. Crawling VoteCast would be
      // harmless but misleading — it asserts that the absence is deliberate.
      const crawler = LogCrisp.buildPluginCrawler(plugin)
      const events = (crawler as any).crawlParams.events.map((item: any) => item.event)

      expect(events).to.not.include('VoteCast')
      expect(configIndexer.some((item: any) => item.event === 'VoteCast')).to.be.true
    })

    it('should start from the plugin block', () => {
      const crawler = LogCrisp.buildPluginCrawler(plugin)
      expect((crawler as any).crawlParams.fromBlock).to.equal(plugin.blockNumber)
    })
  })

  describe('buildTokenCrawler', () => {
    it('should crawl the token from the token block', () => {
      const crawler = LogCrisp.buildTokenCrawler(plugin, token)

      expect((crawler as any).crawlParams.address).to.deep.equal([plugin.tokenAddress])
      expect((crawler as any).crawlParams.fromBlock).to.equal(token.blockNumber)
    })

    it('should fall back to the plugin block when the token has none', () => {
      const crawler = LogCrisp.buildTokenCrawler(plugin, { ...token, blockNumber: undefined })
      expect((crawler as any).crawlParams.fromBlock).to.equal(plugin.blockNumber)
    })
  })

  describe('processError', () => {
    it('should log the error', async () => {
      const errorStub = sandbox.stub(logger, 'error')
      await LogCrisp.processError(new Error('boom'), plugin, { logIndex: 1 })
      expect(errorStub.calledOnce).to.be.true
    })
  })
})
