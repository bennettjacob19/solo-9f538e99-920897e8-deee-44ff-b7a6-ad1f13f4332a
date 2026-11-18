# 本地服务发现目录（svcdir）

一个运行在 Flask + SQLite 上的小型服务发现目录：运维人员可以在网页上修改
「服务名 → 目标地址」的映射、把名称设为另一名称的**别名**（可串联）、创建命名
备份、并从一个备份恢复。另有 `/resolve` 查询 API 供客户端使用。

当一个后端被多个服务名引用时，不必逐条改址（客户端会在中途查到不同目标）：
把其他名称设为指向同一终点的别名，终点改址后所有别名在**同一个目录版本**里
一起指向新地址。

## 启动

### Docker Compose（推荐）

```bash
docker compose up --build
```

- 网页：<http://localhost:8000/>
- API：`GET http://localhost:8000/resolve?name=orders-api`
- 健康检查：`GET /healthz`
- SQLite 数据与备份都位于命名卷 `svcdir-data` 的 `/data/directory.sqlite3`
  （备份是同一数据库里的版本快照，所以备份与恢复天然原子）。

### 本地运行

```bash
python3 -m pip install -r requirements.txt
SVCDIR_DB=./data/directory.sqlite3 python3 -m svcdir   # 开发用内置服务器
# 或： gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 8 svcdir.__main__:app
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SVCDIR_DB` | `data/directory.sqlite3` | SQLite 文件路径 |
| `SVCDIR_RESTORE_LEASE_SECONDS` | `30` | 恢复租约时长（进程异常死亡后的兜底回收上限） |
| `PORT` | `8000` | 仅用于 `python -m svcdir` |

## 页面与 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 网页：目录（含别名与解析链）、地址/别名表单、查询框、备份列表 |
| GET | `/resolve?name=<服务名>` | 返回该名称的当前终点地址与完整解析链 |
| GET | `/resolve` | 返回整个目录：每个名称 → 当前终点地址 |
| GET | `/api/state` | 当前版本、完整目录（含别名结构）、恢复状态、备份列表 |
| GET | `/api/backups` | 备份列表 |
| POST | `/api/services` | `{"service": ..., "address": ..., "note": ...}` 新增/修改地址 |
| POST | `/api/aliases` | `{"service": ..., "target": ..., "note": ...}` 把名称设为另一名称的别名 |
| DELETE | `/api/services/<名>` | 删除（仍被别名引用的名称会被拒绝） |
| POST | `/api/backups` | `{"name": ...}` 创建命名备份 |
| GET | `/api/backups/<名>/validate` | 校验备份（不修改目录） |
| POST | `/api/backups/<名>/restore` | 从备份恢复 |

浏览器表单走 `POST /services`、`POST /aliases`、`/backups`、`/backups/<名>/restore`，
成功后 303 跳回页面并显示结果或错误。

单名查询响应示例（`web → orders → orders-api` 的别名链）：

```json
{"ok": true, "version": 6, "restore_in_progress": false,
 "name": "web", "kind": "alias", "address": "10.0.0.12:8080",
 "terminal": "orders-api",
 "chain": [{"service": "web", "kind": "alias", "target": "orders"},
           {"service": "orders", "kind": "alias", "target": "orders-api"},
           {"service": "orders-api", "kind": "address", "address": "10.0.0.12:8080"}]}
```

全目录查询只返回终点地址：`{"services": {"web": "10.0.0.12:8080", ...}}`。

## 别名语义

- 名称要么是**地址项**（终点），要么是指向另一名称的**别名**；别名可以再指向
  别名，解析时沿链走到终点。别名存的是目标*名称*，所以终点改址后，所有指向它
  的别名在同一个新版本里一起生效——客户端不会查到新旧混杂的目标。
- **拒绝成环**：设置别名若会形成环（含自指），返回 `409 alias_cycle`。
- **拒绝悬空**：目标名称不存在（找不到终点）返回 `404`；链长超过 64 也会被拒绝。
- **删除保护**：删除仍被别名引用的名称返回 `409 name_in_use`。
- 以上拒绝都发生在发布之前：事务回滚，**不会产生新目录版本**，当前目录保持原样。
- 对别名设置地址会把它变回地址项；对地址项设置别名则变成别名——两者都照常
  生成一个新版本。

## 一致性与恢复语义

实现要点（对应需求逐条）：

- **备份是同一提交点的完整目录。** 目录从不原地修改：每次修改都写入一个
  *完整的新版本*（先复制当前版本的全部行，再改一行），最后一条
  `UPDATE meta SET value=<新版本>` 才是发布。备份行只固定「版本号」，因此
  创建备份期间持续写入不会让备份变成半个目录。**别名关系与地址在同一批行里**，
  所以备份与恢复天然把两者一起归档、一起还原。
- **恢复前校验。** 恢复分为三步：①在一个写事务里登记「恢复中」租约；②只读
  事务里校验备份（条目数、每行服务名/地址/别名目标合法性、重复服务名、
  **别名链完整性**——断链、成环、超长都算损坏、SHA-256 摘要与备份记录比对）；
  ③一个原子写事务创建完整的新版本并切换 `current_version`。
  校验失败 → 直接返回 422，目录一个字节都不动。
- **旧数据库与旧备份继续可用。** 数据库带 `schema_version`：v1 库打开时自动
  迁移（全部既有行视为地址项），既有备份标记为 `svcdir-backup-v1` 格式，校验时
  仍按最初的单地址摘要算法核对；新备份使用覆盖别名结构的
  `svcdir-backup-v2` 摘要。因此损坏的链无法作为有效备份恢复，而旧备份照常恢复。
- **恢复期间查询仍返回当前完整目录。** `current_version` 只在最后一步切换，
  查询永远读它；整个查询在读事务快照里完成，因此不会读到混排的数据。
- **新修改明确拒绝，已受理的修改先结算。** 登记恢复意图需要写锁，所有已受理
  的修改必然先提交完成；之后到达的修改看到有效租约，返回 `409
  restore_in_progress`（网页也会明确提示）。
- **恢复后新查询只见备份地址；先前受理的查询不混用两版。** 切换后新查询用新
  版本；一个在切换前开始的查询持有自己的读快照（`store.read_view()`），
  即使内部重复读取也仍是同一版本。
- **切换中断后重启只呈现原版或完整备份版。** 新版本与版本号切换在同一事务内
  提交；崩在提交前 → 仍是原版，崩在提交后 → 是完整备份版，旧版本的行永不删除。
  恢复者用租约 + 操作系统文件锁（`<db>.restore.lock`）标记存活：进程死亡时
  内核释放锁，重启后立即回收被遗弃的「恢复中」标记，不必等租约到期。
- **并发恢复。** 文件锁 + 数据库内的 `restore_state` 双重互斥，第二个恢复请求
  得到 409。

## 测试

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q
```

关键交错场景覆盖在 `tests/test_svcdir.py`：

- `test_writes_rejected_while_restore_in_progress_and_settled_before`
- `test_query_accepted_before_switch_keeps_one_version`
- `test_concurrent_writers_during_restore_never_mix`
- `test_cross_process_readers_and_writer_during_restore`（独立进程 + WAL 快照）
- `test_corrupt_backup_is_rejected_and_directory_unchanged`
- `test_backup_with_missing_rows_is_rejected`
- `test_interrupted_switch_presents_original_or_complete_backup`
- `test_killed_restorer_leaves_original_and_restart_can_retry`（SIGKILL 恢复进程）
- `test_expired_restore_lease_is_reclaimed_after_restart`
- `test_dead_restorer_is_reclaimed_immediately_on_restart`
- `test_restore_can_run_after_prior_abandoned_marker`
- `test_live_restore_lease_survives_sibling_process_initialization`
- `test_backup_row_pins_one_version_during_continuous_writes`
- `test_http_rejects_writes_and_serves_reads_during_restore`
- 别名：`test_alias_resolve_single_shows_chain` / `test_alias_chaining` /
  `test_alias_full_directory_returns_terminal_addresses` /
  `test_terminal_readdress_moves_all_aliases_in_same_version` /
  `test_alias_and_address_conversions`
- 别名拒绝规则：`test_alias_cycle_rejected_and_no_new_version` /
  `test_alias_to_missing_target_rejected_and_no_new_version` /
  `test_delete_referenced_name_rejected_and_no_new_version` / `test_chain_length_limit`
- 别名与备份：`test_backup_and_restore_preserve_aliases` /
  `test_backup_with_dangling_chain_is_rejected` / `test_backup_with_cycle_is_rejected`
- 旧库兼容：`test_v1_database_migrates_and_old_backup_still_restores` /
  `test_v1_backup_with_tampered_rows_still_rejected`
- 别名交错：`test_alias_reads_see_one_version_while_terminal_moves` /
  `test_alias_chain_consistent_across_restore` / `test_alias_writes_rejected_during_restore`
- `test_http_alias_flow` / `test_http_alias_rejections` / `test_resolve_query_box_on_page`
- `test_api_flow` / `test_html_page_and_forms` / `test_html_escapes_hostile_names`
- `test_api_validation_errors_are_json` / `test_edge_case_inputs_are_rejected_cleanly`

## 布局

```
svcdir/errors.py     错误类型 → HTTP 状态码
svcdir/store.py      目录版本、命名备份、校验、恢复（核心逻辑）
svcdir/web.py        Flask 路由：网页 + API
svcdir/templates/    页面模板
tests/test_svcdir.py 自测（含并发交错）
Dockerfile / docker-compose.yml
```

## 已知限制与未完成项

- **未在 Docker 中实际构建/运行。** 本环境没有 Docker（`docker` 命令不存在），
  因此 Dockerfile 与 compose 文件只做了静态检查。应用本身已用
  `python -m svcdir` 与 gunicorn 在真实 HTTP 上跑通。
- 单容器部署，恢复互斥依赖同一文件系统上的 `flock`；若把数据目录放到不支持
  `flock` 的网络文件系统，会退化为「租约到期才算失效」。
- 备份保存在同一 SQLite 数据库中，可防止误改目录，但不能防磁盘/文件损坏；
  需要异地容灾应另行导出备份文件。
- 未做用户认证与 HTTPS——按需求这是本地运维工具，请只在内网使用。
- 恢复的「已受理查询」保证依赖单个查询请求只在一个读事务里读完（当前实现如此）；
  没有为客户端提供跨多个独立 HTTP 请求的版本固定参数。
