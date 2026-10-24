# 第三方组件

## scrcpy server

- 项目：Genymobile/scrcpy
- 版本：v4.0
- 用途：Android 设备端 H.264 和控制通道服务，不包含桌面客户端。
- 本地文件：`vendor/scrcpy-server-v4.0`
- 上游发布：https://github.com/Genymobile/scrcpy/releases/tag/v4.0
- 上游资产：https://github.com/Genymobile/scrcpy/releases/download/v4.0/scrcpy-server-v4.0
- 许可证：Apache-2.0，随附 [许可证原文](../vendor/scrcpy-LICENSE)。
- SHA-256：`84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a`

本地二进制摘要已与 GitHub 上游 release API 的 `scrcpy-server-v4.0` 资产 `digest` 核对一致。升级该文件时应重新校验摘要、版本参数与协议兼容性，并保留相应许可证和来源记录。

上游 v4.0 根目录的 NOTICE 地址返回 404；这不代表已完成所有依赖或归属通知核验。正式分发前，维护者仍须检查对应源码、资产内嵌通知和第三方分发义务。此记录不是对完整许可证合规的保证。

## npm 与容器依赖

npm 依赖版本由根锁文件记录，各依赖保留自身许可证。容器还通过基础镜像和发行版软件包安装 Node.js、ADB 及系统库；分发容器时须同时检查这些组件的许可证和通知，不应仅检查 npm 包。

## 项目许可证

本项目自身许可证尚未选定。scrcpy 的 Apache-2.0 许可证及 npm 依赖许可证均不自动授予本项目代码的使用、修改或再分发权利。
