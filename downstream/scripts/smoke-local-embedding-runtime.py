"""Load the managed llama.cpp server's required OpenMP runtime, offline."""
import ctypes

# Package presence alone misses an unusable loader/ABI. Exercise the installed
# library before image publication; no models, server or live state are needed.
runtime = ctypes.CDLL("libgomp.so.1")
runtime.omp_get_max_threads.restype = ctypes.c_int
assert runtime.omp_get_max_threads() > 0, "OpenMP runtime cannot report worker capacity"
print("Local embedding OpenMP runtime passed")
