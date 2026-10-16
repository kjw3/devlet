#!/usr/bin/env python3
"""devlet-cuda-probe — raw-driver CUDA data-plane check (ctypes, no deps).

Verifies, in order, that the GPU attached to this container can actually
compute — not just that nvidia-smi works (management plane):
  S1 enumeration        cuInit / cuDeviceGet
  S2 context            cuDevicePrimaryCtxRetain + cuCtxSetCurrent
  S3 device memory      cuMemAlloc
  S4 host<->device      cuMemcpyHtoD / cuMemcpyDtoH roundtrip
  S5 device write       cuMemsetD32 + read-back
  S6 JIT kernel         PTX module load + kernel launch + result verify

NOTE for raw-driver (ctypes) callers: every allocation/memcpy/kernel call
requires a CURRENT context. Calling cuMemAlloc right after cuInit yields
CUDA_ERROR_INVALID_CONTEXT (201) even on a perfectly working GPU — retain
the primary context (S2) first. This probe exists because exactly that
mistake once made a healthy GT 1030 look broken.

Exit 0 and prints "ALL STAGES PASS" on success; non-zero at the first
broken stage. Never used to gate agent startup (see devlet-gpu-check).
"""
import ctypes
import struct
import sys

cuda = ctypes.CDLL("libcuda.so.1")
cuda.cuInit.argtypes = [ctypes.c_uint]
cuda.cuDeviceGetCount.argtypes = [ctypes.POINTER(ctypes.c_int)]
cuda.cuDeviceGet.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_int]
cuda.cuDevicePrimaryCtxRetain.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
cuda.cuCtxSetCurrent.argtypes = [ctypes.c_void_p]
cuda.cuCtxSynchronize.restype = ctypes.c_int
cuda.cuMemAlloc_v2.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_size_t]
cuda.cuMemFree_v2.argtypes = [ctypes.c_void_p]
cuda.cuMemcpyHtoD_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
cuda.cuMemcpyDtoH_v2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
cuda.cuMemsetD32_v2.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t]
cuda.cuModuleLoadData.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p]
cuda.cuModuleGetFunction.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_char_p]
cuda.cuLaunchKernel.argtypes = (
    [ctypes.c_void_p]
    + [ctypes.c_uint] * 6
    + [ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
)

PTX = b"""
.version 7.0
.target sm_61
.visible .entry addone(.param .u64 _in, .param .u64 _out, .param .u32 _n) {
  .reg .pred %p<2>;
  .reg .u32 %r<5>;
  .reg .u64 %rd<9>;
  .reg .f32 %f<3>;
  ld.param.u64 %rd1, [_in];
  ld.param.u64 %rd2, [_out];
  ld.param.u32 %r1, [_n];
  mov.u32 %r2, %tid.x;
  setp.ge.u32 %p1, %r2, %r1;
  @%p1 bra L_DONE;
  cvta.to.global.u64 %rd3, %rd1;
  cvta.to.global.u64 %rd4, %rd2;
  mul.wide.u32 %rd5, %r2, 4;
  add.s64 %rd6, %rd3, %rd5;
  add.s64 %rd7, %rd4, %rd5;
  ld.global.f32 %f1, [%rd6];
  add.f32 %f2, %f1, 0f3F800000;
  st.global.f32 [%rd7], %f2;
L_DONE:
  ret;
}
"""


def chk(stage: str, rc: int) -> None:
    if rc != 0:
        print(f"{stage}: FAIL rc={rc}")
        sys.exit(1)
    print(f"{stage}: OK")


chk("S1 cuInit", cuda.cuInit(0))
n = ctypes.c_int()
chk("S1 cuDeviceGetCount", cuda.cuDeviceGetCount(ctypes.byref(n)))
if n.value < 1:
    print("S1: FAIL — no CUDA devices visible")
    sys.exit(1)
dev = ctypes.c_int()
chk("S1 cuDeviceGet(0)", cuda.cuDeviceGet(ctypes.byref(dev), 0))

ctx = ctypes.c_void_p()
chk("S2 cuDevicePrimaryCtxRetain", cuda.cuDevicePrimaryCtxRetain(ctypes.byref(ctx), dev))
chk("S2 cuCtxSetCurrent", cuda.cuCtxSetCurrent(ctx))

ptr = ctypes.c_void_p()
chk("S3 cuMemAlloc(1 MiB)", cuda.cuMemAlloc_v2(ctypes.byref(ptr), ctypes.c_size_t(1 << 20)))
if not ptr.value:
    print("S3: FAIL — cuMemAlloc returned NULL pointer")
    sys.exit(1)

src = ctypes.create_string_buffer(b"\x5a" * 4096)
dst = ctypes.create_string_buffer(4096)
chk("S4 cuMemcpyHtoD", cuda.cuMemcpyHtoD_v2(ptr, ctypes.cast(src, ctypes.c_void_p), 4096))
chk("S4 cuMemcpyDtoH", cuda.cuMemcpyDtoH_v2(ctypes.cast(dst, ctypes.c_void_p), ptr, 4096))
print("S4 roundtrip:", "OK" if dst.raw == src.raw[:4096] else "MISMATCH")

chk("S5 cuMemsetD32(1.0f)", cuda.cuMemsetD32_v2(ptr, 0x3F800000, 1024))
chk("S5 cuMemcpyDtoH verify", cuda.cuMemcpyDtoH_v2(ctypes.cast(dst, ctypes.c_void_p), ptr, 4096))
vals = struct.unpack("<1024f", dst.raw)
ok = all(abs(v - 1.0) < 1e-9 for v in vals)
print("S5 device write:", "OK" if ok else f"MISMATCH (first={vals[0]!r})")

# S6: JIT-compile the PTX above and launch it — N input floats +1.0 each.
module = ctypes.c_void_p()
chk("S6 cuModuleLoadData(PTX)", cuda.cuModuleLoadData(ctypes.byref(module), PTX))
func = ctypes.c_void_p()
chk("S6 cuModuleGetFunction(addone)", cuda.cuModuleGetFunction(ctypes.byref(func), module, b"addone"))

N = 256
in_dev, out_dev = ctypes.c_void_p(), ctypes.c_void_p()
chk("S6 cuMemAlloc(in)", cuda.cuMemAlloc_v2(ctypes.byref(in_dev), ctypes.c_size_t(N * 4)))
chk("S6 cuMemAlloc(out)", cuda.cuMemAlloc_v2(ctypes.byref(out_dev), ctypes.c_size_t(N * 4)))
host_in = struct.pack(f"<{N}f", *range(N))
host_out = ctypes.create_string_buffer(N * 4)
chk("S6 cuMemcpyHtoD(in)", cuda.cuMemcpyHtoD_v2(in_dev, ctypes.cast(host_in, ctypes.c_void_p), N * 4))

n_arg = ctypes.c_uint(N)
params = (ctypes.c_void_p * 3)(
    ctypes.cast(ctypes.byref(in_dev), ctypes.c_void_p),
    ctypes.cast(ctypes.byref(out_dev), ctypes.c_void_p),
    ctypes.cast(ctypes.byref(n_arg), ctypes.c_void_p),
)
chk(
    "S6 cuLaunchKernel(256 threads)",
    cuda.cuLaunchKernel(func, 1, 1, 1, N, 1, 1, 0, None, params, None),
)
chk("S6 cuCtxSynchronize", cuda.cuCtxSynchronize())
chk("S6 cuMemcpyDtoH(out)", cuda.cuMemcpyDtoH_v2(ctypes.cast(host_out, ctypes.c_void_p), out_dev, N * 4))
out_vals = struct.unpack(f"<{N}f", host_out.raw)
kernel_ok = all(abs(o - (i + 1.0)) < 1e-6 for i, o in enumerate(out_vals))
print("S6 JIT kernel result:", "OK" if kernel_ok else f"MISMATCH (out[0]={out_vals[0]!r})")

cuda.cuMemFree_v2(out_dev)
cuda.cuMemFree_v2(in_dev)
cuda.cuMemFree_v2(ptr)
cuda.cuDevicePrimaryCtxRelease(dev)

all_ok = ok and dst.raw[:4096] != b"\x00" * 4096 and kernel_ok
print("ALL STAGES PASS" if all_ok else "DATA PLANE BROKEN")
sys.exit(0 if all_ok else 1)
