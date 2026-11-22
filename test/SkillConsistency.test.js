const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const { COMMANDS, parseDuration } = require("../bin/agentry");

const SKILL_DIR = path.join(__dirname, "..", "skills", "agentry");

function readAllMarkdown(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...readAllMarkdown(p));
    else if (e.name.endsWith(".md")) files.push(p);
  }
  return files;
}

describe("Skill 与 CLI 的一致性", function () {
  const docs = readAllMarkdown(SKILL_DIR);

  it("Skill 目录结构符合币安的格式", function () {
    expect(fs.existsSync(path.join(SKILL_DIR, "SKILL.md"))).to.equal(true);
    expect(fs.existsSync(path.join(SKILL_DIR, "references"))).to.equal(true);
  });

  it("SKILL.md 有合法的 frontmatter", function () {
    const src = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(src.startsWith("---\n")).to.equal(true);

    const end = src.indexOf("\n---", 4);
    expect(end, "frontmatter 没有闭合").to.be.greaterThan(0);

    const fm = src.slice(4, end);
    expect(fm).to.match(/^name:\s*agentry/m);
    expect(fm).to.match(/^description:/m);
  });

  it("文档里提到的每一个命令都真的存在", function () {
    // 这条测试是为了堵住一类很实际的毛病：文档写了但 CLI 没实现，
    // Agent 照着文档调就会失败。这种不一致人工 review 很容易漏
    const referenced = new Set();

    for (const file of docs) {
      let src = fs.readFileSync(file, "utf8");

      // 跳过 YAML frontmatter：那里的 `name: agentry` 换行接 `description:`，
      // 跨行匹配会把 YAML 的键当成命令名
      if (src.startsWith("---\n")) {
        const end = src.indexOf("\n---", 4);
        if (end > 0) src = src.slice(end + 4);
      }

      // 只match同一行（不跨换行），且后面不是冒号
      const re = /\bagentry[ \t]+([a-z][a-z-]*)(?![:\w-])/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (m[1] !== "help") referenced.add(m[1]);
      }
    }

    expect(referenced.size, "文档里一个命令都没提到？").to.be.greaterThan(8);

    const missing = [...referenced].filter((c) => !(c in COMMANDS));
    expect(missing, "文档承诺了但 CLI 没实现：" + missing.join(", ")).to.be.empty;
  });

  it("文档里链接的参考文件都真的存在", function () {
    // 和上一条同一类毛病：SKILL.md 的路由表引用了 discovery.md，
    // 但那个文件一度根本不存在。链接坏掉比命令缺失更难发现
    const broken = [];

    for (const file of docs) {
      const src = fs.readFileSync(file, "utf8");
      const re = /\]\((references\/[a-z0-9-]+\.md)\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const target = path.join(SKILL_DIR, m[1]);
        if (!fs.existsSync(target)) broken.push(path.basename(file) + " → " + m[1]);
      }
    }

    expect(broken, "链接指向不存在的文件：" + broken.join(", ")).to.be.empty;
  });

  it("每份参考文件都被 SKILL.md 引用到", function () {
    // 反过来：写了但没挂进路由表的文档，Agent 永远找不到
    const src = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    const refs = fs.readdirSync(path.join(SKILL_DIR, "references"));

    const orphan = refs.filter((f) => !src.includes("references/" + f));
    expect(orphan, "写了但没被 SKILL.md 引用：" + orphan.join(", ")).to.be.empty;
  });

  it("CLI 的 --help 覆盖了所有命令", function () {
    // 反过来：实现了但没在 help 里列出来的，用户发现不了
    let printed = "";
    const orig = console.log;
    console.log = (s) => { printed += s; };
    try {
      require("../bin/agentry").usage();
    } finally {
      console.log = orig;
    }

    const missing = Object.keys(COMMANDS).filter((c) => !printed.includes("agentry " + c));
    expect(missing, "实现了但 help 里没列出：" + missing.join(", ")).to.be.empty;
  });

  it("SKILL.md 明确禁止代替用户执行", function () {
    const src = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(src).to.include("preview");
    expect(src).to.include("确认");
    expect(src).to.match(/不要.*execute|绝不代替/);
  });

  it("SKILL.md 写明了两项前置检查", function () {
    // 币安的参考实现特意强调 Developer Mode 要提前查，
    // 否则用户会在最后一步才发现走不通
    const src = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(src).to.include("baw wallet agent-id");
    expect(src).to.include("baw wallet settings");
  });

  it("陪审文档讲清了会亏钱", function () {
    // 不承诺收益是红线。只讲能分到钱的那一半是不行的
    const src = fs.readFileSync(path.join(SKILL_DIR, "references", "jury.md"), "utf8");
    expect(src).to.include("没收");
    expect(src).to.match(/期望值是负|会亏钱/);
  });

  it("没有索取私钥或助记词的字样", function () {
    for (const file of docs) {
      const src = fs.readFileSync(file, "utf8");
      // 提到「不索取」是可以的，但不能有索取的指示
      expect(src, file).to.not.match(/(请|需要|输入).{0,6}(助记词|私钥|配对码)/);
    }
  });
});

describe("CLI 参数解析", function () {
  it("时长接受秒数与带后缀的写法", function () {
    expect(parseDuration("86400")).to.equal(86400);
    expect(parseDuration("1d")).to.equal(86400);
    expect(parseDuration("24h")).to.equal(86400);
    expect(parseDuration("90m")).to.equal(5400);
    expect(parseDuration("30s")).to.equal(30);
    expect(parseDuration("1.5d")).to.equal(129600);
  });
});
