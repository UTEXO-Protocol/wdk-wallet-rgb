// Custom serializer for BigInt to allow Jest to serialize BigInt values
if (expect && expect.addSnapshotSerializer) {
  expect.addSnapshotSerializer({
    test: (val) => typeof val === 'bigint',
    print: (val) => String(val) + 'n'
  })
}
