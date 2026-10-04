const { ethers } = require("hardhat");

// Deploys Vault, Settlement and two mintable test ERC-20s, then prints the
// addresses as JSON. The Settlement address is derived from the deployer
// nonce before Vault is deployed, because both contracts take each other
// (one direction only) as immutable constructor arguments:
// Vault is deployed at nonce N, Settlement at nonce N+1.
async function main() {
  const [deployer] = await ethers.getSigners();
  const baseNonce = await ethers.provider.getTransactionCount(deployer.address);

  const settlementAddress = ethers.getCreateAddress({
    from: deployer.address,
    nonce: baseNonce + 1,
  });

  const Vault = await ethers.getContractFactory("Vault");
  const vault = await Vault.deploy(settlementAddress);
  await vault.waitForDeployment();

  const Settlement = await ethers.getContractFactory("Settlement");
  const settlement = await Settlement.deploy(await vault.getAddress());
  await settlement.waitForDeployment();

  if ((await settlement.getAddress()) !== settlementAddress) {
    throw new Error("Settlement address prediction mismatch");
  }

  const TestToken = await ethers.getContractFactory("TestToken");
  const baseToken = await TestToken.deploy("OpenBook Base Token", "OBBASE");
  await baseToken.waitForDeployment();
  const quoteToken = await TestToken.deploy("OpenBook Quote Token", "OBQUOTE");
  await quoteToken.waitForDeployment();

  console.log(
    JSON.stringify({
      deployer: deployer.address,
      vault: (await vault.getAddress()),
      settlement: (await settlement.getAddress()),
      baseToken: (await baseToken.getAddress()),
      quoteToken: (await quoteToken.getAddress()),
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
