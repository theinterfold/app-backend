import '@test/environment'
import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import CrispHelper from '@helpers/crisp'
import ProposalHelper from '@helpers/proposal'
import logger from '@logger'
import { IPluginInterfaceType, IPluginStatus, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('Handlers: CrispInterfoldHandler', () => {
  let sandbox: SinonSandbox
  let getTallyStub: SinonStub
  let getDivisorStub: SinonStub

  const network = NetworksEnum.ethereumSepolia
  const pluginAddress = '0x1111111111111111111111111111111111111111'
  const otherPluginAddress = '0x2222222222222222222222222222222222222222'
  const coordinator = '0x3333333333333333333333333333333333333333'
  const otherCoordinator = '0x4444444444444444444444444444444444444444'
  const lookAlike = '0x5555555555555555555555555555555555555555'
  const daoAddress = '0x6666666666666666666666666666666666666666'

  const createPlugin = (address: string, interfoldAddress?: string) =>
    Models.Plugin.create({
      address,
      daoAddress,
      network,
      interfaceType: IPluginInterfaceType.crisp,
      status: IPluginStatus.installed,
      blockNumber: 1000,
      transactionHash: `0xinstall${address}`,
      interfoldAddress,
    })

  const createProposal = (plugin: string, proposalIndex: string, e3Id?: string, votingPowerDivisor?: string) =>
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
      e3Id,
      votingPowerDivisor,
    } as any)

  const event = (name: string, args: Record<string, bigint>, address = coordinator) => ({
    parsedEvent: { name, args } as any,
    info: { address, network, blockNumber: 1200, transactionHash: '0xevent' } as any,
  })
  const published = (e3Id: bigint, address?: string) => event('PlaintextOutputPublished', { e3Id }, address)
  const failed = (e3Id: bigint, reason: bigint, address?: string) => event('E3Failed', { e3Id, reason }, address)

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.stub(logger, 'error')
    sandbox.stub(logger, 'warn')
    getTallyStub = sandbox.stub(CrispHelper, 'getTally').resolves([6n, 3n, 1n])
    getDivisorStub = sandbox.stub(CrispHelper, 'getVotingPowerDivisor').resolves('1000')
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('plaintextOutputPublished', () => {
    it('should store the tally in raw token units, mapped to the vote options, and mark it published', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7', '1000000000000')

      await CrispInterfoldHandler.plaintextOutputPublished(published(7n).parsedEvent, published(7n).info)

      const proposal = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(getTallyStub.calledOnceWith(pluginAddress, network, '1')).to.be.true
      expect(proposal.isTallyPublished).to.be.true
      // CRISP orders its options YES, NO, ABSTAIN; the API serves the token voting types ABSTAIN 1, YES 2, NO 3
      expect(
        proposal.metrics.votesByOption.map(({ type, totalVotingPower }) => ({ type, totalVotingPower })),
      ).to.deep.equal([
        { type: 2, totalVotingPower: '6000000000000' },
        { type: 3, totalVotingPower: '3000000000000' },
        { type: 1, totalVotingPower: '1000000000000' },
      ])
      expect(proposal.metrics.votesByOption.every(option => option.totalVotes === 0)).to.be.true
    })

    it('should read the divisor of a proposal that has none yet and store it', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7')

      await CrispInterfoldHandler.plaintextOutputPublished(published(7n).parsedEvent, published(7n).info)

      const proposal = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(getDivisorStub.calledOnceWith(coordinator, '7', network)).to.be.true
      expect(proposal.votingPowerDivisor).to.equal('1000')
      expect(proposal.metrics.votesByOption[0].totalVotingPower).to.equal('6000')
    })

    it('should store nothing while the divisor cannot be read, and publish once it can', async () => {
      getDivisorStub.onFirstCall().rejects(new Error('rpc'))
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7')

      await CrispInterfoldHandler.plaintextOutputPublished(published(7n).parsedEvent, published(7n).info)

      const unpublished = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(unpublished.isTallyPublished).to.not.equal(true)
      expect(unpublished.votingPowerDivisor).to.equal(undefined)
      expect(unpublished.metrics.votesByOption).to.have.length(0)

      await CrispInterfoldHandler.plaintextOutputPublished(published(7n).parsedEvent, published(7n).info)

      const proposal = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(proposal.isTallyPublished).to.be.true
      expect(proposal.votingPowerDivisor).to.equal('1000')
      expect(proposal.metrics.votesByOption[0].totalVotingPower).to.equal('6000')
    })

    it('should ignore an event whose emitter is not the coordinator the plugin stored', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7', '1000')

      await CrispInterfoldHandler.plaintextOutputPublished(
        published(7n, lookAlike).parsedEvent,
        published(7n, lookAlike).info,
      )

      const proposal = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(getTallyStub.called).to.be.false
      expect(proposal.isTallyPublished).to.not.equal(true)
    })

    it('should apply an e3Id only to the proposal of the plugin using the emitting coordinator', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createPlugin(otherPluginAddress, otherCoordinator)
      await createProposal(pluginAddress, '1', '7', '1000')
      await createProposal(otherPluginAddress, '1', '7', '1000')

      await CrispInterfoldHandler.plaintextOutputPublished(
        published(7n, otherCoordinator).parsedEvent,
        published(7n, otherCoordinator).info,
      )

      expect(getTallyStub.calledOnceWith(otherPluginAddress, network, '1')).to.be.true
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).isTallyPublished).to.not.equal(true)
      expect(
        (await Models.Proposal.findOne({ pluginAddress: otherPluginAddress, proposalIndex: '1' })).isTallyPublished,
      ).to.be.true
    })

    it('should not read the tally again once it is published', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7', '1000')
      await Models.Proposal.updateOne({ pluginAddress }, { $set: { isTallyPublished: true } })

      await CrispInterfoldHandler.plaintextOutputPublished(published(7n).parsedEvent, published(7n).info)

      expect(getTallyStub.called).to.be.false
    })

    it('should keep applying the batch when the read of one proposal fails', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7', '1000')
      await createProposal(pluginAddress, '2', '8', '1000')
      getTallyStub.onFirstCall().rejects(new Error('rpc')).onSecondCall().resolves([2n, 0n, 0n])

      await CrispInterfoldHandler.plaintextOutputPublishedBatch([published(7n), published(8n)])

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).isTallyPublished).to.not.equal(true)
      const second = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '2' })
      expect(second.isTallyPublished).to.be.true
      expect(second.metrics.votesByOption[0].totalVotingPower).to.equal('2000')
    })
  })

  describe('e3Failed', () => {
    it('should store the failure reason of the proposal', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7')

      await CrispInterfoldHandler.e3Failed(failed(7n, 6n).parsedEvent, failed(7n, 6n).info)

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).failureReason).to.equal(6)
    })

    it('should ignore an event whose emitter is not the stored coordinator, or an unknown e3Id', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7')

      await CrispInterfoldHandler.e3FailedBatch([failed(7n, 6n, lookAlike), failed(8n, 6n)])

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).failureReason).to.equal(undefined)
    })

    it('should keep applying the batch when an event cannot be handled', async () => {
      await createPlugin(pluginAddress, coordinator)
      await createProposal(pluginAddress, '1', '7')

      await CrispInterfoldHandler.e3FailedBatch([
        { parsedEvent: { name: 'E3Failed', args: {} } as any, info: failed(7n, 6n).info },
        failed(7n, 9n),
      ])

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).failureReason).to.equal(9)
    })
  })

  describe('syncTally', () => {
    it('should store the final tally of an executed proposal, in raw token units', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      const proposal = await createProposal(pluginAddress, '1', '7', '10')
      getTallyStub.resolves([5n, 4n, 3n])

      await CrispInterfoldHandler.syncTally(proposal, plugin)

      const stored = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(stored.isTallyPublished).to.be.true
      expect(stored.metrics.votesByOption.map(option => option.totalVotingPower)).to.deep.equal(['50', '40', '30'])
    })

    it('should leave the proposal untouched when the tally cannot be read', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      const proposal = await createProposal(pluginAddress, '1', '7', '10')
      getTallyStub.rejects(new Error('rpc'))

      await CrispInterfoldHandler.syncTally(proposal, plugin)

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).isTallyPublished).to.not.equal(true)
    })

    it('should store nothing when the round has no divisor, however it is read', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      const read = await createProposal(pluginAddress, '1', '7')
      const stored = await createProposal(pluginAddress, '2', '8', '0')
      getDivisorStub.resolves('0')

      await CrispInterfoldHandler.syncTally(read, plugin)
      await CrispInterfoldHandler.syncTally(stored, plugin)

      for (const proposalIndex of ['1', '2']) {
        const proposal = await Models.Proposal.findOne({ pluginAddress, proposalIndex })
        expect(proposal.isTallyPublished).to.not.equal(true)
        expect(proposal.metrics.votesByOption).to.have.length(0)
      }
      // a stored zero is not trusted: it is read again
      expect(getDivisorStub.calledTwice).to.be.true
      expect((logger.warn as SinonStub).calledTwice).to.be.true
    })

    it('should skip a tally index that has no vote option', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      const proposal = await createProposal(pluginAddress, '1', '7', '10')
      getTallyStub.resolves([1n, 2n, 3n, 4n])

      await CrispInterfoldHandler.syncTally(proposal, plugin)

      const stored = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(stored.metrics.votesByOption).to.have.length(3)
    })
  })

  describe('ensureInterfold', () => {
    it('should read and store the coordinator once', async () => {
      const plugin = await createPlugin(pluginAddress)
      const getInterfoldStub = sandbox.stub(CrispHelper, 'getInterfold').resolves(coordinator as any)

      await CrispInterfoldHandler.ensureInterfold(plugin)
      await CrispInterfoldHandler.ensureInterfold(plugin)

      expect(getInterfoldStub.calledOnce).to.be.true
      expect((await Models.Plugin.findOne({ address: pluginAddress })).interfoldAddress).to.equal(coordinator)
    })
  })

  describe('readProposalData', () => {
    const onChain = {
      e3Id: 7n,
      parameters: { snapshotBlock: 900n, minVotingPower: 50n, minParticipation: 20n, supportThreshold: 60n },
    }
    let getProposalStub: SinonStub
    let totalVotingPowerStub: SinonStub

    beforeEach(() => {
      getProposalStub = sandbox.stub(ProposalHelper, 'getProposalCrisp').resolves(onChain as any)
      totalVotingPowerStub = sandbox.stub(CrispHelper, 'getTotalVotingPower').resolves('123456')
    })

    it('should read the frozen parameters, the supply at the snapshot and the divisor', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)

      const data = await CrispInterfoldHandler.readProposalData(plugin, '1', network)

      expect(getProposalStub.calledOnceWith({ proposalIndex: '1', pluginAddress, network, blockNumber: undefined })).to
        .be.true
      expect(totalVotingPowerStub.calledOnceWith(pluginAddress, network, 900n)).to.be.true
      expect(getDivisorStub.calledOnceWith(coordinator, '7', network)).to.be.true
      expect(data).to.deep.equal({
        e3Id: '7',
        historicalTotalSupply: '123456',
        votingPowerDivisor: '1000',
        settings: { minParticipation: 20, supportThreshold: 60, minVoterVotingPower: '50' },
      })
    })

    it('should read the proposal at the given block', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)

      await CrispInterfoldHandler.readProposalData(plugin, '1', network, 1100)

      expect(getProposalStub.calledOnceWith({ proposalIndex: '1', pluginAddress, network, blockNumber: 1100 })).to.be
        .true
    })

    it('should leave the divisor unset when the round has none', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      getDivisorStub.resolves('0')

      const data = await CrispInterfoldHandler.readProposalData(plugin, '1', network)

      expect(data?.votingPowerDivisor).to.equal(undefined)
    })

    it('should read and store the coordinator when the plugin has none', async () => {
      const plugin = await createPlugin(pluginAddress)
      sandbox.stub(CrispHelper, 'getInterfold').resolves(coordinator as any)

      await CrispInterfoldHandler.readProposalData(plugin, '1', network)

      expect(getDivisorStub.calledOnceWith(coordinator, '7', network)).to.be.true
      expect((await Models.Plugin.findOne({ address: pluginAddress })).interfoldAddress).to.equal(coordinator)
    })

    it('should keep what could be read when other reads fail', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      totalVotingPowerStub.rejects(new Error('rpc'))
      getDivisorStub.rejects(new Error('rpc'))

      const data = await CrispInterfoldHandler.readProposalData(plugin, '1', network)

      expect(data).to.deep.equal({
        e3Id: '7',
        historicalTotalSupply: undefined,
        votingPowerDivisor: undefined,
        settings: { minParticipation: 20, supportThreshold: 60, minVoterVotingPower: '50' },
      })
    })

    it('should return null for a proposal the contract does not have', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)

      getProposalStub.resolves(null)
      expect(await CrispInterfoldHandler.readProposalData(plugin, '1', network)).to.equal(null)

      getProposalStub.resolves({ ...onChain, parameters: { ...onChain.parameters, snapshotBlock: 0n } })
      expect(await CrispInterfoldHandler.readProposalData(plugin, '1', network)).to.equal(null)
      expect(totalVotingPowerStub.called).to.be.false
    })
  })

  describe('backfillProposal', () => {
    const onChain = {
      e3Id: 7n,
      parameters: { snapshotBlock: 900n, minVotingPower: 50n, minParticipation: 20n, supportThreshold: 60n },
    }
    let getProposalStub: SinonStub

    beforeEach(() => {
      getProposalStub = sandbox.stub(ProposalHelper, 'getProposalCrisp').resolves(onChain as any)
      sandbox.stub(CrispHelper, 'getTotalVotingPower').resolves('5000')
    })

    it('should store the round, the frozen parameters and the supply at the snapshot', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      const proposal = await createProposal(pluginAddress, '1')

      expect(await CrispInterfoldHandler.backfillProposal(proposal, plugin)).to.be.true

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
      const plugin = await createPlugin(pluginAddress, coordinator)
      const proposal = await createProposal(pluginAddress, '1')
      await Models.Proposal.updateOne(
        { _id: proposal._id },
        { $set: { executed: { status: true, blockNumber: 1200 } } },
      )

      await CrispInterfoldHandler.backfillProposal((await Models.Proposal.findById(proposal._id))!, plugin)

      const stored = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(stored.isTallyPublished).to.be.true
      expect(stored.metrics.votesByOption.map(option => option.totalVotingPower)).to.deep.equal([
        '6000',
        '3000',
        '1000',
      ])
    })

    it('should leave the tally of an open proposal to the Interfold events', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      const proposal = await createProposal(pluginAddress, '1')

      await CrispInterfoldHandler.backfillProposal(proposal, plugin)

      expect(getTallyStub.called).to.be.false
    })

    it('should report a proposal the contract does not have and store nothing', async () => {
      const plugin = await createPlugin(pluginAddress, coordinator)
      const proposal = await createProposal(pluginAddress, '1')
      getProposalStub.resolves(null)

      expect(await CrispInterfoldHandler.backfillProposal(proposal, plugin)).to.be.false
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).e3Id).to.equal(undefined)
    })
  })
})
