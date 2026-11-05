import '@test/environment'
import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import CrispHelper from '@helpers/crisp'
import ProposalHelper from '@helpers/proposal'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import backfillCrispProposalsMigration, {
  backfillCrispProposal,
} from '@src/migrations/20261105120000-backfillCrispProposals'
import { EnumQueueName, IPluginInterfaceType, IPluginStatus, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('migration: backfillCrispProposals', () => {
  let sandbox: SinonSandbox
  let sendMessageStub: SinonStub
  let getProposalStub: SinonStub

  const network = NetworksEnum.ethereumSepolia
  const pluginAddress = '0x1111111111111111111111111111111111111111'
  const otherPluginAddress = '0x2222222222222222222222222222222222222222'
  const coordinator = '0x3333333333333333333333333333333333333333'
  const daoAddress = '0x6666666666666666666666666666666666666666'

  const createPlugin = (address: string, interfaceType = IPluginInterfaceType.crisp) =>
    Models.Plugin.create({
      address,
      daoAddress,
      network,
      interfaceType,
      status: IPluginStatus.installed,
      blockNumber: 1000,
      transactionHash: `0xinstall${address}`,
      interfoldAddress: coordinator,
    })

  const createProposal = (plugin: string, proposalIndex: string, extra: Record<string, unknown> = {}) =>
    Models.Proposal.create({
      transactionHash: `0xcreate${plugin}${proposalIndex}`,
      blockNumber: 1100,
      network,
      pluginAddress: plugin,
      daoAddress,
      proposalIndex,
      creatorAddress: '0x7777777777777777777777777777777777777777',
      startDate: 1,
      endDate: 2,
      incrementalId: Number(proposalIndex),
      proposalId: `0x0${proposalIndex}`,
      snapshot: { totalSupply: '10' },
      ...extra,
    } as any)

  const onChain = (e3Id: bigint) => ({
    e3Id,
    parameters: { snapshotBlock: 900n, minVotingPower: 50n, minParticipation: 20n, supportThreshold: 60n },
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sendMessageStub = sandbox.stub(RabbitMQHelper, 'sendMessage').resolves()
    sandbox.stub(logger, 'info')
    sandbox.stub(logger, 'verbose')
    sandbox.stub(logger, 'error')
    getProposalStub = sandbox
      .stub(ProposalHelper, 'getProposalCrisp')
      .callsFake(async ({ proposalIndex }) => onChain(BigInt(proposalIndex) + 6n) as any)
    sandbox.stub(CrispHelper, 'getTotalVotingPower').resolves('5000')
    sandbox.stub(CrispHelper, 'getVotingPowerDivisor').resolves('1000')
    sandbox.stub(CrispHelper, 'getTally').resolves([3n, 2n, 1n])
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('backfillCrispProposal', () => {
    it('should store the round, the frozen parameters and the supply at the snapshot', async () => {
      const plugin = await createPlugin(pluginAddress)
      const proposal = await createProposal(pluginAddress, '1')

      expect(await backfillCrispProposal(proposal, plugin)).to.be.true

      const stored = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(stored.e3Id).to.equal('7')
      expect(stored.isTallyPublished).to.be.false
      expect(stored.votingPowerDivisor).to.equal('1000')
      expect(stored.snapshot.totalSupply).to.equal('5000')
      expect(stored.settings.minParticipation).to.equal(20)
      expect(stored.settings.supportThreshold).to.equal(60)
      expect(stored.settings.minVoterVotingPower).to.equal('50')
    })

    it('should read the final tally of an executed proposal', async () => {
      const plugin = await createPlugin(pluginAddress)
      const proposal = await createProposal(pluginAddress, '1', { executed: { status: true, blockNumber: 1200 } })

      await backfillCrispProposal(proposal, plugin)

      const stored = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(stored.isTallyPublished).to.be.true
      expect(stored.metrics.votesByOption.map(option => option.totalVotingPower)).to.deep.equal([
        '3000',
        '2000',
        '1000',
      ])
    })

    it('should leave the tally of an open proposal to the Interfold crawl', async () => {
      const plugin = await createPlugin(pluginAddress)
      const proposal = await createProposal(pluginAddress, '1')

      await backfillCrispProposal(proposal, plugin)

      expect((CrispHelper.getTally as SinonStub).called).to.be.false
    })

    it('should report a proposal the contract does not have', async () => {
      const plugin = await createPlugin(pluginAddress)
      const proposal = await createProposal(pluginAddress, '1')
      getProposalStub.resolves(null)

      expect(await backfillCrispProposal(proposal, plugin)).to.be.false
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).e3Id).to.equal(undefined)
    })
  })

  describe('start', () => {
    it('should backfill the CRISP proposals that have no round, then queue the Interfold crawl of the network', async () => {
      await createPlugin(pluginAddress)
      await createPlugin(otherPluginAddress, IPluginInterfaceType.tokenVoting)
      await createProposal(pluginAddress, '1')
      await createProposal(pluginAddress, '2', { e3Id: '99' })
      await createProposal(otherPluginAddress, '1')

      await backfillCrispProposalsMigration.start()

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).e3Id).to.equal('7')
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '2' })).e3Id).to.equal('99')
      expect((await Models.Proposal.findOne({ pluginAddress: otherPluginAddress, proposalIndex: '1' })).e3Id).to.equal(
        undefined,
      )
      expect(getProposalStub.calledOnce).to.be.true
      expect(sendMessageStub.calledOnceWith(EnumQueueName.logInterfold, { id: network, params: { network } })).to.be
        .true
    })

    it('should skip a proposal it cannot backfill and continue with the others', async () => {
      await createPlugin(pluginAddress)
      await createProposal(pluginAddress, '1')
      await createProposal(pluginAddress, '2')
      await createProposal(pluginAddress, '3')
      getProposalStub.callsFake(async ({ proposalIndex }) => {
        if (proposalIndex === '1') return null
        if (proposalIndex === '2') throw new Error('rpc')
        return onChain(9n) as any
      })

      await backfillCrispProposalsMigration.start()

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).e3Id).to.equal(undefined)
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '2' })).e3Id).to.equal(undefined)
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '3' })).e3Id).to.equal('9')
      expect(sendMessageStub.calledOnce).to.be.true
    })

    it('should go on when the coordinator of a plugin cannot be read', async () => {
      const plugin = await createPlugin(pluginAddress)
      await Models.Plugin.updateOne({ _id: plugin._id }, { $unset: { interfoldAddress: 1 } })
      await createProposal(pluginAddress, '1')
      sandbox.stub(CrispInterfoldHandler, 'ensureInterfold').rejects(new Error('rpc'))

      await backfillCrispProposalsMigration.start()

      expect(sendMessageStub.calledOnce).to.be.true
    })
  })
})
