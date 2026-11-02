export const BondedVotes = {
  abi: [
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          internalType: 'address',
          name: 'owner',
          type: 'address',
        },
        {
          indexed: true,
          internalType: 'address',
          name: 'fromDelegate',
          type: 'address',
        },
        {
          indexed: true,
          internalType: 'address',
          name: 'toDelegate',
          type: 'address',
        },
      ],
      name: 'BondedDelegateChanged',
      type: 'event',
    },
  ],
}

export const BondedCheckpoints = {
  abi: [
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          internalType: 'address',
          name: 'bondOwner',
          type: 'address',
        },
        {
          indexed: true,
          internalType: 'uint48',
          name: 'timepoint',
          type: 'uint48',
        },
        {
          indexed: false,
          internalType: 'uint256',
          name: 'amount',
          type: 'uint256',
        },
      ],
      name: 'BondedCheckpointed',
      type: 'event',
    },
  ],
}
