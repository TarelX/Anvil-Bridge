const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Checkpoints } = require("../src/checkpoints");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-checkpoint-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-checkpoint-storage-"));
  const file = "测试回滚.txt";
  const target = path.join(root, file);

  try {
    const checkpoints = new Checkpoints(root, storage);

    // 1. 修改前快照 → 编辑 → 单文件回滚（中文文件名是常态）
    await fs.writeFile(target, "原始内容\n", "utf8");
    const first = await checkpoints.capture("修改前快照 · 编辑 测试回滚.txt", [file]);
    assert.ok(first?.id, "应创建检查点");
    await fs.writeFile(target, "修改后的内容\n第二行\n", "utf8");

    const listed = await checkpoints.list(5);
    assert.equal(listed[0]?.files?.[0]?.path, file, "检查点路径必须保留中文文件名");
    assert.equal(listed[0]?.files?.[0]?.added, 2, "应统计自该检查点以来的新增行数");

    const diff = await checkpoints.diff(first.id, file);
    assert.ok(diff.includes("+++ b/" + file), "差异必须包含中文文件名: " + diff);
    assert.ok(diff.includes("+修改后的内容"), "差异必须包含修改后的内容");

    const restored = await checkpoints.restore(first.id, file);
    assert.equal(restored.file, file, "回滚目标路径必须保留中文文件名");
    assert.deepEqual(restored.restoredFiles, [file], "应报告还原的文件");
    assert.equal(await fs.readFile(target, "utf8"), "原始内容\n", "中文文件名对应的文件应恢复");

    // 2. 内容一致时应报告无需回滚，而不是静默成功
    const again = await checkpoints.restore(first.id, file);
    assert.equal(again.unchanged, true, "内容一致时应返回 unchanged");

    // 3. 新增文件：快照时还不存在 → 回滚应删除
    const created = "新建的说明.md";
    const second = await checkpoints.capture("修改前快照 · 新建文件", [created]);
    await fs.writeFile(path.join(root, created), "内容\n", "utf8");
    const rows = await checkpoints.list(5);
    const row = rows.find((item) => item.id === second.id);
    assert.equal(row?.files?.[0]?.path, created, "新增文件的路径必须保留中文文件名");
    assert.equal(row?.files?.[0]?.status, "A", "新增文件状态应为 A");
    const removed = await checkpoints.restore(second.id);
    assert.deepEqual(removed.removedFiles, [created], "回滚应删除该检查点之后新增的文件");
    await assert.rejects(fs.readFile(path.join(root, created), "utf8"), "新增文件应已被删除");

    // 4. 删除文件：快照时存在 → 回滚应恢复，且只有删除时保护性检查点也不能中断
    const gone = "待恢复.txt";
    await fs.writeFile(path.join(root, gone), "保留我\n", "utf8");
    const third = await checkpoints.capture("修改前快照 · 删除文件", [gone]);
    await fs.rm(path.join(root, gone));
    const back = await checkpoints.restore(third.id);
    assert.deepEqual(back.restoredFiles, [gone], "被删除的文件应被还原");
    assert.equal(await fs.readFile(path.join(root, gone), "utf8"), "保留我\n", "被删除的文件应恢复内容");

    // 5. 回滚前一定留下保护性检查点：保护性检查点记录回滚前的状态，回滚它等于撤销刚才的还原
    const list = await checkpoints.list(5);
    const protective = list.find(
      (item) => item.summary.includes("回滚前保护性检查点") && item.files.some((f) => f.path === gone),
    );
    assert.ok(protective, "应创建保护性检查点: " + JSON.stringify(list.map((i) => i.summary)));
    const undo = await checkpoints.restore(protective.id, gone);
    assert.deepEqual(undo.removedFiles, [gone], "回滚保护性检查点应回到回滚前的状态");
    await assert.rejects(fs.readFile(path.join(root, gone), "utf8"), "回滚前的状态里该文件不存在");

    // 6. 再回滚到修改前快照，文件与内容都应回来（回滚本身可再回滚）
    const redo = await checkpoints.restore(third.id);
    assert.deepEqual(redo.restoredFiles, [gone], "再次回滚到修改前快照应还原文件");
    assert.equal(await fs.readFile(path.join(root, gone), "utf8"), "保留我\n", "再次回滚应恢复文件内容");

    console.log("CHECKPOINT_UNICODE_OK");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(storage, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});