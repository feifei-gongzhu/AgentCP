# fscan 侦察引擎镜像构建（P3，§6.6-3）

Sorne 的 `url_scan` / `ip_scan` 由 fscan 适配器（`src/sorne/engine_adapters/fscan_adapter.py`）
驱动，运行在本地 Docker 镜像 `sorne-engines/fscan:2.2.2` 中（可用环境变量
`SORNE_FSCAN_IMAGE` 覆盖）。本仓库**不**随源码分发二进制；镜像按以下步骤
在部署机上构建（来源与哈希已固定在适配器 `DESCRIPTOR` 中）。

## 1. 下载并校验

```sh
curl -L -o checksums.txt \
  https://github.com/shadow1ng/fscan/releases/download/v2.2.2/checksums.txt
curl -L -o fscan_2.2.2_linux_arm64 \
  https://github.com/shadow1ng/fscan/releases/download/v2.2.2/fscan_2.2.2_linux_arm64
shasum -a 256 -c <(grep 'fscan_2.2.2_linux_arm64' checksums.txt)
# 期望：cfa5a78adc0b310811af11c0b9bdaaeda0d8443d271ad2c0b28b8b52064eb9fe
```

x86_64 部署机改用 `fscan_2.2.2_linux_x64`（checksums.txt 内有对应哈希）。
GitHub Release 直连不可达时使用可信镜像代理，但**必须**以官方
checksums.txt 校验哈希（方案 §6.6：不能从不可信下载链接直接执行未知文件）。

## 2. 构建镜像

```sh
printf 'FROM alpine:3.21\nCOPY fscan_2.2.2_linux_arm64 /usr/local/bin/fscan\nRUN chmod 0555 /usr/local/bin/fscan\nENTRYPOINT ["fscan"]\n' > Dockerfile
docker build -t sorne-engines/fscan:2.2.2 .
```

## 3. 验证

```sh
docker run --rm sorne-engines/fscan:2.2.2 -help
python3 -c "import sys; sys.path.insert(0,'src'); \
  from sorne.engine_adapters import fscan_adapter as f; \
  print(f.availability_status())"
# 期望 (True, '')
```

## 许可与来源

- fscan：MIT License（shadow1ng/fscan，https://github.com/shadow1ng/fscan）。
- 版本 2.2.2（Release 提交 2ede41d 2026-10-01）。
- 引擎选择依据见适配器模块 docstring（§6.6-3：容器兼容性、`-f json`
  结构化输出、固定 argv + 进程组取消、逐目标批次恢复；dddd 无官方
  Release 资产且 GUI 优先，作为后续引擎）。
