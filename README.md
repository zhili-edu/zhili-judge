# README

Create rootfs:

```bash
debootstrap --variant=minbase --include=gcc,g++ focal ./rootfs https://mirrors.tuna.tsinghua.edu.cn/ubuntu
mkdir -p rootfs/sandbox/1 rootfs/sandbox/2 rootfs/sandbox/3
```
