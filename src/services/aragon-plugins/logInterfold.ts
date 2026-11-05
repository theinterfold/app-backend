import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import ConfigIndexerHelper from '@helpers/configIndexer'
import RabbitMQHelper from '@helpers/rabbitMQ'
import configIndexer from '@indexer/configIndexer'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import { BlockchainLogCrawler } from '@modules/crawlers'
import {
  EnumQueueName,
  type HexAddress,
  type IIndexerConfig,
  IInterfoldLogs,
  IPluginInterfaceType,
  IPluginStatus,
  type NetworksEnum,
} from '@types'

const llo = logger.logMeta.bind(null, { service: 'service:indexer:LogInterfold' })

export const LogInterfold = {
  // Crawls, per Interfold coordinator of the indexed CRISP plugins of the network, the events that report the outcome
  // of their rounds. A coordinator that fails does not stop the others.
  start: async (network: NetworksEnum) => {
    const plugins = await Models.Plugin.find({
      network,
      interfaceType: IPluginInterfaceType.crisp,
      status: IPluginStatus.installed,
      interfoldAddress: { $exists: true },
    })

    // no round can exist before the first plugin of the coordinator
    const fromBlocks = new Map<HexAddress, number>()
    for (const { interfoldAddress, blockNumber } of plugins) {
      fromBlocks.set(interfoldAddress!, Math.min(blockNumber, fromBlocks.get(interfoldAddress!) ?? blockNumber))
    }

    const events = configIndexer.filter((item: IIndexerConfig) =>
      Object.values(IInterfoldLogs).includes(item.event as IInterfoldLogs),
    )

    const results = await Promise.allSettled(
      [...fromBlocks].map(async ([interfold, fromBlock]) => {
        const crawler = new BlockchainLogCrawler({
          onlyHistorical: true,
          network,
          events,
          address: [interfold],
          fromBlock,
          onError: async (error: any, log: any) =>
            logger.error('Error LogInterfold', llo({ network, interfold, log, error })),
          logService: ConfigIndexerHelper.builders.interfold(network, interfold),
          stopOnError: true,
        })

        await crawler.crawl()
        await crawler.end()
        logger.verbose('End LogInterfold sync', llo({ network, interfold, lastSync: crawler.crawlSetting.lastSync }))
      }),
    )

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(
          'LogInterfold sync failed',
          llo({ network, interfold: [...fromBlocks.keys()][index], error: result.reason }),
        )
      }
    })
  },

  // Stores the plugin's coordinator, then queues the crawl of its network. Run once the plugin's own events are
  // indexed; events of a round whose proposal is not indexed yet (another plugin on the same coordinator) are skipped,
  // and the round sweep settles that proposal later.
  queue: async (plugin: Plugin) => {
    try {
      await CrispInterfoldHandler.ensureInterfold(plugin)
      await RabbitMQHelper.sendMessage(EnumQueueName.logInterfold, {
        id: plugin.network,
        params: { network: plugin.network },
      })
    } catch (error) {
      logger.error('Cannot queue LogInterfold', llo({ network: plugin.network, pluginAddress: plugin.address, error }))
    }
  },
}
