import ConfigIndexerHelper from '@helpers/configIndexer'
import configIndexer from '@indexer/configIndexer'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import type Token from '@models/schema/token'
import { BlockchainLogCrawler } from '@modules/crawlers'
import { LogTokenVoting } from '@services/aragon-plugins/logTokenVoting'
import { ICrispVotingLogs, IGovernanceErc20Logs, type IIndexerConfig, ITokenType } from '@types'

const llo = logger.logMeta.bind(null, { service: 'service:indexer:LogCrisp' })

/**
 * Crawls a CrispVoting plugin and its governance token.
 *
 * Same shape as token voting, including its token dispatch: the plugin emits proposal, metadata
 * and settings events, while delegation changes come from the token — `DelegateVotesChanged`
 * from a plain ERC20Votes token, or the voting-escrow adapter events (crawled by
 * `LogTokenVoting.buildEscrowCrawler`) when the token is typed `escrowAdapter`. BondedVotes, the
 * token the deployed CRISP plugins vote with, is typed `escrowAdapter` but has no escrow behind
 * it (`plugin.votingEscrow` is unset) and emits neither, so only the plugin is crawled for it —
 * exactly as for a token voting plugin on the same token.
 *
 * The difference from token voting is what is *not* crawled: there is no VoteCast event, because
 * ballots are encrypted and submitted to the E3 round rather than to the plugin. A CRISP
 * proposal therefore has proposals and settings but never votes, and its tally only becomes
 * readable on-chain once the ciphernode committee publishes it.
 */
export const LogCrisp = {
  start: async (plugin: Plugin, token: Token, isHistorical?: boolean) => {
    const infoLogs = {
      network: plugin.network,
      daoAddress: plugin.daoAddress,
      pluginAddress: plugin.address,
      tokenAddress: token?.address,
    }
    logger.verbose('Start LogCrisp', llo(infoLogs))

    const pluginCrawler = LogCrisp.buildPluginCrawler(plugin, isHistorical)
    const tokenCrawler =
      token.type === ITokenType.escrowAdapter
        ? plugin.votingEscrow?.escrowAddress
          ? LogTokenVoting.buildEscrowCrawler(plugin, token, isHistorical)
          : null
        : LogCrisp.buildTokenCrawler(plugin, token, isHistorical)
    const crawlers = [pluginCrawler, tokenCrawler].filter(
      (crawler): crawler is BlockchainLogCrawler => crawler !== null,
    )

    const startTime = Date.now()

    await Promise.all(crawlers.map(crawler => crawler.crawl()))
    await Promise.all(crawlers.map(crawler => crawler.end()))

    logger.verbose(
      'End LogCrisp',
      llo({
        ...infoLogs,
        syncStrategy: 'BlockchainLogCrawler',
        lastPluginSyncBlock: pluginCrawler.crawlSetting.lastSync,
        lastTokenSyncBlock: tokenCrawler?.crawlSetting.lastSync,
        startTime,
        endTime: Date.now(),
      }),
    )
  },

  buildPluginCrawler: (plugin: Plugin, isHistorical?: boolean) => {
    const configCrispLogs = configIndexer.filter((item: IIndexerConfig) =>
      Object.values(ICrispVotingLogs).includes(item.event as any),
    )

    return new BlockchainLogCrawler({
      onlyHistorical: isHistorical,
      network: plugin.network,
      events: [...configCrispLogs],
      address: [plugin.address],
      fromBlock: plugin?.blockNumber,
      onError: async (error: any, log: any) => LogCrisp.processError(error, plugin, log),
      logService: ConfigIndexerHelper.builders.plugin(plugin.interfaceType, plugin.network, plugin.address),
      stopOnError: true,
    })
  },

  buildTokenCrawler: (plugin: Plugin, token: Token, isHistorical?: boolean) => {
    const configGovLogs = configIndexer.filter((item: IIndexerConfig) =>
      Object.values(IGovernanceErc20Logs).includes(item.event as any),
    )

    return new BlockchainLogCrawler({
      onlyHistorical: isHistorical,
      network: plugin.network,
      events: [...configGovLogs],
      address: [plugin.tokenAddress],
      fromBlock: token?.blockNumber || plugin?.blockNumber,
      onError: async (error: any, log: any) => LogCrisp.processError(error, plugin, log),
      logService: ConfigIndexerHelper.builders.token(token.type, token.network, token.address),
      stopOnError: true,
    })
  },

  processError: async (error: any, plugin: Plugin, log: any) => {
    logger.error(
      'Error LogCrisp',
      llo({
        log,
        error,
        plugin,
      }),
    )
  },
}
