# GeoSpoof 中文说明（geospoof-gfw）

> 本仓库是上游 [GeoSpoof](https://github.com/GeoSpoof/geospoof) 的 fork。
> 其余功能（VPN 同步、分站位置、语言、指纹防护等）与上游一致。
## 它是干什么的

VPN 只改 IP，浏览器还会通过定位 API、时区、`Intl`、WebRTC 等信号泄露真实位置。
GeoSpoof 把这些信号统一改成你选的位置，让浏览器报出的位置和 VPN 出口一致。

本 fork 解决的是反向问题：人在 VPN 后面时，大陆网站（银行、本地服务等）
反而希望看到真实位置和时区，一旦被伪装就会异常。于是加了一个**分标签页的关闭开关**。

## 本 fork 新增：大陆直连规则

- 默认：伪装常开，位置与 VPN 同步。
- 命中大陆规则的标签页：**只对这个标签页不伪装**，它看到的是真实位置和时区，
  其它标签页继续用主位置。全局开关不动。
- 从大陆站切到海外站：下一次加载自动恢复伪装，不用手动开关。
- 手动分站位置优先：如果某个站在 Per-site locations 里手动设过位置，
  手动设置会盖住直连规则。
- 工具栏徽标：绿勾 ✓ 表示该页正在伪装；灰蓝小点 • 表示该页不在伪装范围内
  （包括命中直连规则）；总开关关掉时没有徽标。

设置位置：点工具栏 GeoSpoof 图标 → **Filters** 标签页 → **Mainland direct rules** 区。

## 快速开始

1. 主界面先设好主位置（选城市，或开 VPN 同步），总开关保持开。
2. Filters 的模式选**“全部”**。注意：如果模式是“允许列表”且列表为空，
   所有站都不伪装，直连规则也就无从发挥——这是最常见的配错。
3. 在 Mainland direct rules 区确认总开关开着，把规则粘进大文本框，点 **Save**。
4. 已经打开的标签页要**刷新**才生效。
5. 以后加站，自己加一行、再点 Save 即可。

## 规则写法

一行一条。只看主机名，不看路径和参数，所以栏目、分页、搜索页都不用单独加规则：
`zhihu.com/question/xxx?page=2` 和 `zhihu.com/column/xxx` 都是同一个主机。

| 写法                   | 含义                                   |
| ---------------------- | -------------------------------------- |
| `baidu.com`（裸域名）  | 匹配该域名及其所有子域名               |
| `DOMAIN,baidu.com`     | 只精确匹配这一个主机                   |
| `DOMAIN-SUFFIX,qq.com` | 匹配该域名及其所有子域名               |
| `DOMAIN-KEYWORD,weibo` | 主机名里包含这个词就匹配               |
| `IP-CIDR,223.5.5.0/24` | 只在网址本身就是 IPv4 数字时按网段判断 |
| `*.example.com`        | 只匹配子域名，不含 `example.com` 本身  |
| `.example.com`         | 同裸域名                               |
| `                      |                                        | example.com^` | 同裸域名（取主机部分） |

注释行以 `!`、`#`、`//` 开头，空行会被跳过。
不支持的类型（`GEOIP`、`GEOSITE`、`RULE-SET`、`MATCH`、正则、`IP-CIDR6`、
带 `,no-resolve` 的 IP 段）保存时会计入无效行，不会静默变成别的规则。

**不要粘 GFWList 或任何 Proxy 列表。**那是“大陆被墙、需代理的海外站列表”，
方向正好反过来：粘了会把 Google、YouTube 关掉伪装，把百度、淘宝继续伪装。
这里要的是大陆直连列表。

## 整表粘贴：ACL4SSR 大陆直连表

唯一推荐整表粘贴的是：

<https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaDomain.list>

打开链接，全选复制，粘进文本框，点 Save。保存成功的正常结果是：

```
Saved 625 rules. 9 invalid lines skipped. 1 duplicate line skipped.
```

不要被原表的 1409 行吓到：里面有大量空行和注释，有效规则就是 625 条，
9 条无效是第一版不支持的 IP 段，1 条是重复去重。看到这个数字就是粘全了。

注意：该表里混有少量海外站的中国直连项（例如 epicgames、sony、playstation）。
只想关纯大陆站，就用下面的精简规则，或者从整表里删掉不需要的行。

不要整表粘 blackmatrix7 的 ChinaMax：它有 12 万多条，远超本功能 2000 条的上限。

## 精简规则（可直接粘贴）

第一行 `cn` 覆盖所有 `.cn` 站（包括 `12306.cn`、`gov.cn`、`edu.cn`）：

```
cn
baidu.com
qq.com
wechat.com
taobao.com
tmall.com
jd.com
pinduoduo.com
bilibili.com
zhihu.com
douban.com
weibo.com
iqiyi.com
youku.com
douyin.com
kuaishou.com
xiaohongshu.com
163.com
126.com
sina.com
sohu.com
ctrip.com
meituan.com
dianping.com
csdn.net
cnblogs.com
gitee.com
alipay.com
huawei.com
xiaomi.com
```

也可以从 FlClash 的规则里复制 `DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、
`IP-CIDR` 开头的行：带 `,DIRECT` 的可以粘，带 `,PROXY`、`,REJECT` 的不要粘。

## 验证方法

保存后刷新标签页：

- 大陆站（百度、淘宝）：应显示真实位置和时区，例如北京时间 UTC+8。
- 海外站（Google）：应显示主位置（与 VPN 同步的位置）。
- 从大陆站切回海外站，刷新一次，伪装应自动恢复。
- 两个标签页同时打开时时区不同（一个 UTC+8、一个 GMT-7），就是分标签页生效的证据；
  如果是全局开关，两边只会是一个时区。

不生效时先查三点：直连开关是否开着；保存时该规则有没有被计入无效行；
该站有没有在 Per-site locations 里手动设过位置（手动设置会盖住直连规则）。
再查 Filters 模式是不是“全部”。



## 从源码安装（未上架商店、未签名）

```bash
npm ci
npm run build:firefox    # Firefox 构建，产物在 dist/
npm run build:chromium   # Chromium 构建，产物在 dist/
```

- Firefox：打开 `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
  选 `dist/` 里的 `manifest.json`。临时扩展重启浏览器后会消失，需重装，属正常。
- Chrome / Edge / Brave：打开 `chrome://extensions` → 打开开发者模式 →
  Load unpacked → 选整个 `dist/` 文件夹（不是选压缩包）。

## 相关链接

- 上游项目：<https://github.com/GeoSpoof/geospoof>
- 英文文档：[README.md](README.md)
- 用户指南：[docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- 隐私政策：[PRIVACY_POLICY.md](PRIVACY_POLICY.md)
