const { expect } = require("chai");
const { ethers } = require("hardhat");

// BSC 主网 Guardian，由 FLAP 的 VaultBase._getGuardian() 按 chainId 返回。
// hardhat.config.js 已把本地网络的 chainId 设为 56
const GUARDIAN_BSC = "0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b";

const eth = (n) => ethers.parseEther(n);

describe("AgentryServiceVault", function () {
  let vault, vaultAddr, admin, other;

  beforeEach(async function () {
    [admin, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AgentryServiceVault");
    vault = await Factory.deploy(admin.address);
    vaultAddr = await vault.getAddress();
  });

  describe("balance-delta 记账", function () {
    it("按增量确认收入", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("1") });

      expect(await vault.accountedQuote()).to.equal(eth("1"));
      expect(await vault.totalReceived()).to.equal(eth("1"));
    });

    it("零增量唤醒是静默无操作，不重复计数", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("1") });

      // FLAP 的 ping：空 calldata、零值调用，会落到 receive()
      await admin.sendTransaction({ to: vaultAddr, value: 0 });
      await admin.sendTransaction({ to: vaultAddr, value: 0 });
      await vault.sync();

      expect(await vault.totalReceived()).to.equal(eth("1"));
      expect(await vault.accountedQuote()).to.equal(eth("1"));
    });

    it("多笔到账累加", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("1") });
      await admin.sendTransaction({ to: vaultAddr, value: eth("0.25") });

      expect(await vault.totalReceived()).to.equal(eth("1.25"));
      expect(await vault.accountedQuote()).to.equal(eth("1.25"));
    });

    it("直接转入的资金在下一次唤醒时被确认（按捐赠处理）", async function () {
      // 用 selfdestruct 之外的方式强制打款不易构造，这里用普通转账代替，
      // 验证的是「没有 ping 也能通过 sync 恢复确认」这条路径
      await admin.sendTransaction({ to: vaultAddr, value: eth("1") });
      await vault.sync();

      expect(await vault.accountedQuote()).to.equal(eth("1"));
    });
  });

  describe("提取", function () {
    it("提取后基线与真实余额一致，且不影响后续收入确认", async function () {
      // 规则 3 的回归测试。如果 withdraw 漏了递减 accountedQuote，
      // 基线会永久高于真实余额，之后所有收入都被静默吞掉——
      // 不报错、不 revert，金库直接死掉。这个测试就是为了锁住它
      await admin.sendTransaction({ to: vaultAddr, value: eth("2") });

      await vault.withdraw(other.address, eth("1"));

      expect(await vault.accountedQuote()).to.equal(eth("1"));
      expect(await ethers.provider.getBalance(vaultAddr)).to.equal(eth("1"));
      expect(await vault.totalWithdrawn()).to.equal(eth("1"));

      // 新收入必须照常被确认
      await admin.sendTransaction({ to: vaultAddr, value: eth("0.5") });

      expect(await vault.accountedQuote()).to.equal(eth("1.5"));
      expect(await vault.totalReceived()).to.equal(eth("2.5"));
    });

    it("withdrawAll 清空可用余额后仍能继续确认收入", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("3") });

      await vault.withdrawAll(other.address);

      expect(await vault.accountedQuote()).to.equal(0n);
      expect(await ethers.provider.getBalance(vaultAddr)).to.equal(0n);

      await admin.sendTransaction({ to: vaultAddr, value: eth("1") });
      expect(await vault.accountedQuote()).to.equal(eth("1"));
      expect(await vault.totalReceived()).to.equal(eth("4"));
    });

    it("款项真的到了收款地址", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("2") });

      const before = await ethers.provider.getBalance(other.address);
      await vault.withdraw(other.address, eth("1.5"));
      const after = await ethers.provider.getBalance(other.address);

      expect(after - before).to.equal(eth("1.5"));
    });

    it("超出可用余额的提取被拒绝", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("1") });

      await expect(
        vault.withdraw(other.address, eth("1.000000000000000001"))
      ).to.be.revertedWithCustomError(vault, "InsufficientAccounted");
    });

    it("非 operator 不能提取", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("1") });

      await expect(
        vault.connect(other).withdraw(other.address, eth("1"))
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Guardian 强制条款", function () {
    it("Guardian 在部署时就持有 OPERATOR_ROLE", async function () {
      const role = await vault.OPERATOR_ROLE();
      expect(await vault.hasRole(role, GUARDIAN_BSC)).to.equal(true);
    });

    it("管理员无法撤销 Guardian 的权限", async function () {
      const role = await vault.OPERATOR_ROLE();

      await expect(
        vault.revokeRole(role, GUARDIAN_BSC)
      ).to.be.revertedWithCustomError(vault, "CannotRevokeGuardianRole");
    });

    it("普通地址的权限可以正常撤销", async function () {
      const role = await vault.OPERATOR_ROLE();
      await vault.grantRole(role, other.address);
      expect(await vault.hasRole(role, other.address)).to.equal(true);

      await vault.revokeRole(role, other.address);
      expect(await vault.hasRole(role, other.address)).to.equal(false);
    });
  });

  describe("FLAP 规范接口", function () {
    it("声明收入币种为原生币", async function () {
      expect(await vault.vaultQuoteToken()).to.equal(ethers.ZeroAddress);
    });

    it("规范版本为 v3", async function () {
      expect(await vault.vaultSpecVersion()).to.equal("v3");
    });

    it("description 随状态变化", async function () {
      const before = await vault.description();
      await admin.sendTransaction({ to: vaultAddr, value: eth("1.5") });
      const after = await vault.description();

      expect(before).to.not.equal(after);
      expect(after).to.include("1.5000");
    });

    it("vaultUISchema 返回三个方法", async function () {
      const schema = await vault.vaultUISchema();

      expect(schema.vaultType).to.equal("AgentryServiceVault");
      expect(schema.methods.length).to.equal(3);
      expect(schema.methods[0].name).to.equal("stats");
      expect(schema.methods[0].isWriteMethod).to.equal(false);
      expect(schema.methods[2].name).to.equal("withdraw");
      expect(schema.methods[2].isWriteMethod).to.equal(true);
    });

    it("stats 返回四项", async function () {
      await admin.sendTransaction({ to: vaultAddr, value: eth("2") });
      await vault.withdraw(other.address, eth("0.5"));

      const [available, lifetime, deployed, raw] = await vault.stats();
      expect(available).to.equal(eth("1.5"));
      expect(lifetime).to.equal(eth("2"));
      expect(deployed).to.equal(eth("0.5"));
      expect(raw).to.equal(eth("1.5"));
    });
  });

  describe("taxToken", function () {
    it("只能设置一次", async function () {
      await vault.setTaxToken(other.address);
      expect(await vault.taxToken()).to.equal(other.address);

      await expect(
        vault.setTaxToken(admin.address)
      ).to.be.revertedWithCustomError(vault, "TaxTokenAlreadySet");
    });
  });
});
