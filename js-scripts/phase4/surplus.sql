-- Aave Rescue Mission Phase 4: underlying transferred straight into its own aToken.
-- Every legitimate inflow of underlying (supply, repay, liquidation, flash loan repayment)
-- runs through the Pool and emits a Pool log in the same transaction; a transfer whose
-- transaction emitted none is a user mistake. One pass over the slice reads the candidate
-- transfers and the Pool logs together and flags each transaction with a window function.
-- Each row is re-verified against the transaction receipt over RPC before it counts.
-- The block_time bounds only prune partitions; the block_number bounds define the window.
SELECT
  block_number,
  tx_hash,
  index,
  topic1 AS from_topic,
  data AS amount,
  tx_from,
  tx_to
FROM (
  SELECT
    block_number,
    tx_hash,
    index,
    topic1,
    data,
    tx_from,
    tx_to,
    contract_address,
    bool_or(contract_address = {{pool}}) OVER (PARTITION BY block_number, tx_hash) AS pool_touched
  FROM {{chain}}.logs
  WHERE
    block_time >= TIMESTAMP '{{fromTime}}'
    AND block_time < TIMESTAMP '{{toTime}}'
    AND block_number BETWEEN {{fromBlock}} AND {{toBlock}}
    AND (
      (
        contract_address = {{token}}
        AND topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef -- Transfer(address,address,uint256)
        AND topic2 = {{holderTopic}}
      )
      OR contract_address = {{pool}}
    )
)
WHERE contract_address = {{token}} AND NOT pool_touched
ORDER BY block_number, index
