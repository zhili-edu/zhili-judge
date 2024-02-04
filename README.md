# README

Create rootfs:

```bash
debootstrap --variant=minbase --include=gcc,g++,language-pack-zh-hans focal ./rootfs https://mirrors.tuna.tsinghua.edu.cn/ubuntu
cp ./gcc-9.mo ./rootfs/usr/share/locale/zh_CN/LC_MESSAGES/
```
