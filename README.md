# 轻账 CloudRun Express 后端

基于微信云托管 Express 模板改造，为轻账微信小程序提供多人账本 API。保留模板的 Docker 构建方式，Express 接口使用 `POST /api/ledger`。

## 云托管环境变量

在服务控制台配置以下变量，不要把数据库密码提交到仓库：

- `MYSQL_ADDRESS`：MySQL 内网地址，格式为 `host:port`
- `MYSQL_USERNAME`：数据库账号
- `MYSQL_PASSWORD`：数据库密码
- `MYSQL_DATABASE`：可选，默认使用模板数据库 `nodejs_demo`
- `ADMIN_OPENID`：管理员微信 OpenID

服务启动时会自动创建 `ledger_users`、`ledger_transactions`、`ledger_catalog` 三张表。

## 接口

- `GET /health`：健康检查
- `GET /api/wx_openid`：通过微信云托管可信链路读取当前 OpenID
- `POST /api/ledger`：用户登记、用户管理、产品目录和交易记录操作

请求体使用 JSON，例如 `{ "action": "whoAmI" }`。可用操作由小程序 `wechat_miniprogram/utils/store.js` 调用，包括 `ensureUser`、`getCatalog`、`saveCatalog`、`listTransactions`、`saveTransaction`、`deleteTransaction` 和管理员用户管理操作。

## 权限与数据

- 小程序端使用 `wx.cloud.callContainer`，通过可信微信链路访问本服务。
- 服务端按微信 OpenID 隔离交易记录，并由 `ADMIN_OPENID` 控制管理员身份。
- 建议关闭服务公网访问，只保留小程序云托管调用链路。
- 新用户首次登记后为待启用状态。管理员页面可显示当前 OpenID；将管理员 OpenID 配入环境变量并重新部署后，管理员账号自动启用。
- 销售净利润按优惠后收入减去采购成本计算。成本在保存时形成快照，产品目录以后修改不会改变已保存交易的成本。

## 部署

将本仓库连接到 CloudBase 云托管服务并部署。请在云托管控制台设置数据库环境变量和 `ADMIN_OPENID`，不要在小程序代码或仓库里保存密码。
