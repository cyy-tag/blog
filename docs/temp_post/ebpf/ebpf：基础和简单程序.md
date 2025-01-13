## ebpf 简介

## bpf hello world

### 测试环境
Ubuntu24.04

uname -a : Linux cyy 6.8.0-44-generic #44-Ubuntu SMP PREEMPT_DYNAMIC Tue Aug 13 13:35:26 UTC 2024 x86_64 x86_64 x86_64 GNU/Linux

### ebpf 内核部分代码

```C
//file: hello_world.ebpf.c
struct pt_regs {
	unsigned long r15;
	unsigned long r14;
	unsigned long r13;
	unsigned long r12;
	unsigned long bp;
	unsigned long bx;
/* arguments: non interrupts/non tracing syscalls only save up to here*/
	unsigned long r11;
	unsigned long r10;
	unsigned long r9;
	unsigned long r8;
	unsigned long ax;
	unsigned long cx;
	unsigned long dx;
	unsigned long si;
	unsigned long di;
	unsigned long orig_ax;
/* end of arguments */
/* cpu exception frame or undefined */
	unsigned long ip;
	unsigned long cs;
	unsigned long flags;
	unsigned long sp;
	unsigned long ss;
/* top of stack page */
};

__attribute__((section("ksyscall/execve"), used))
int __execve(struct pt_regs *ctx)
{
  return 0;
}
```

+ struct pt_regs 是Linux内核中的一个结构体，用于保存进程在被中断时的寄存器状态。我们可以通过pt_regs获取到当前上下文信息

​	参数，返回值等信息，这里测试用x86_64代码，因此这里复制的Linux内核 /arch/x86/include/asm/ptrace.h[^2]中代码片段。

+ \_\_attribute__((section("ksyscall/execve"), used))[^1]
  + \__attribute((************))\_\_ 编译器注解（annotations）格式 对源代码提供额外的属性
  + section("ksyscall/execve")  指定全局变量或函数（这里指__execve函数）放在"ksyscall/execve"名称的section中
  + used 告诉编译器即使该函数没有被显示使用，也要保留在最终的可执行文件中，并阻止进行优化，防止没有显示引用的变量或函数被删除。

使用clang编译ebpf程序生成ebpf字节文件

```sh
clang -O2 -target bpf -c hello_world.ebpf.c -o hello_world.ebpf.o
```

使用readelf查看生成的hello_world.ebpf.o文件信息

```tex
root@ubuntu2204-test:hello_world# readelf -S hello_world.ebpf.o
There are 6 section headers, starting at offset 0xf0:

Section Headers:
  [Nr] Name              Type             Address           Offset
       Size              EntSize          Flags  Link  Info  Align
  [ 0]                   NULL             0000000000000000  00000000
       0000000000000000  0000000000000000           0     0     0
  [ 1] .strtab           STRTAB           0000000000000000  00000099
       0000000000000051  0000000000000000           0     0     1
  [ 2] .text             PROGBITS         0000000000000000  00000040
       0000000000000000  0000000000000000  AX       0     0     4
  [ 3] ksyscall/execve   PROGBITS         0000000000000000  00000040
       0000000000000010  0000000000000000  AX       0     0     8
  [ 4] .llvm_addrsig     LOOS+0xfff4c03   0000000000000000  00000098
       0000000000000001  0000000000000000   E       5     0     1
  [ 5] .symtab           SYMTAB           0000000000000000  00000050
       0000000000000048  0000000000000018           1     2     8
Key to Flags:
  W (write), A (alloc), X (execute), M (merge), S (strings), I (info),
  L (link order), O (extra OS processing required), G (group), T (TLS),
  C (compressed), x (unknown), o (OS specific), E (exclude),
  D (mbind), p (processor specific)
```

可以看到这里生成一个"ksyscall/execve"的section，可以再使用llvm-objdump查看ebpf的字节码

```text
root@ubuntu2204-test:hello_world# llvm-objdump -d hello_world.ebpf.o 

hello_world.ebpf.o:     file format elf64-bpf

Disassembly of section ksyscall/execve:

0000000000000000 <__execve>:
       0:       b7 00 00 00 00 00 00 00 r0 = 0
       1:       95 00 00 00 00 00 00 00 exit
```

### 用户层代码

```C
```





## 引用

[^1]:[Attributes in Clang — Clang 20.0.0git documentation](https://clang.llvm.org/docs/AttributeReference.html#section-declspec-allocate)
[^2]:[ptrace.h - arch/x86/include/asm/ptrace.h - Linux source code v5.19.17 - Bootlin Elixir Cross Referencer](https://elixir.bootlin.com/linux/v5.19.17/source/arch/x86/include/asm/ptrace.h)
