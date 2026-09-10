# include .env file and export its env vars
# (-include to ignore error if it does not exist)
-include .env

# deps
update:; forge update

# Build & test
build  :; forge build --sizes
test   :; forge test -vvv

# Deploy an AaveMerkleDistributor owned by the chain's Governance V3 executor (resolved by chain id).
# Requires RPC_<CHAIN>, ETHERSCAN_V2_API_KEY, LEDGER_SENDER and MNEMONIC_INDEX in .env.
# Example: make deploy-distributor chain=base
deploy-distributor :; forge script scripts/DeployMerkleDistributor.s.sol:DeployMerkleDistributor --rpc-url ${chain} --broadcast --ledger --mnemonic-indexes ${MNEMONIC_INDEX} --sender ${LEDGER_SENDER} --etherscan-api-key ${ETHERSCAN_V2_API_KEY} --verify -vvvv
