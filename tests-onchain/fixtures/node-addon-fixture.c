// SPDX-License-Identifier: Apache-2.0
// Test-only Node-API boundary. The production addon never loads JavaScript handlers.
#define _GNU_SOURCE
#include <node_api.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct {
  napi_ref handler;
  char *destroy_path;
  int closed;
} fixture_handle;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, "FIXTURE_ERROR", message);
  return NULL;
}

static void close_handle(fixture_handle *handle) {
  if (handle->closed) return;
  handle->closed = 1;
  if (handle->destroy_path) {
    FILE *file = fopen(handle->destroy_path, "a");
    if (file) { fputs("destroy\n", file); fclose(file); }
  }
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)hint;
  fixture_handle *handle = data;
  close_handle(handle);
  napi_delete_reference(env, handle->handler);
  free(handle->destroy_path);
  free(handle);
}

static napi_value create(napi_env env, napi_callback_info info) {
  (void)info;
  Dl_info image;
  if (dladdr((const void *)&create, &image) == 0) return fail(env, "Cannot locate fixture");
  const char suffix[] = ".fixture.cjs";
  size_t size = strlen(image.dli_fname) + sizeof(suffix);
  char *path = malloc(size);
  if (!path) return fail(env, "Cannot allocate path");
  snprintf(path, size, "%s%s", image.dli_fname, suffix);
  napi_value script, loader, filename, undefined, handler, object, marker;
  napi_status status = napi_create_string_utf8(env,
      "(path => process.getBuiltinModule('module').createRequire(path)(path))",
      NAPI_AUTO_LENGTH, &script);
  if (status == napi_ok) status = napi_run_script(env, script, &loader);
  if (status == napi_ok) status = napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &filename);
  free(path);
  if (status == napi_ok) status = napi_get_undefined(env, &undefined);
  if (status == napi_ok) status = napi_call_function(env, undefined, loader, 1, &filename, &handler);
  if (status != napi_ok) return NULL;
  napi_valuetype type;
  if (napi_typeof(env, handler, &type) != napi_ok || type != napi_function) return fail(env, "Fixture must export a function");
  fixture_handle *handle = calloc(1, sizeof(*handle));
  if (!handle) return fail(env, "Cannot allocate handle");
  if (napi_create_reference(env, handler, 1, &handle->handler) != napi_ok) { free(handle); return NULL; }
  if (napi_get_named_property(env, handler, "destroyPath", &marker) == napi_ok &&
      napi_typeof(env, marker, &type) == napi_ok && type == napi_string) {
    size_t length;
    if (napi_get_value_string_utf8(env, marker, NULL, 0, &length) == napi_ok) {
      handle->destroy_path = malloc(length + 1);
      if (handle->destroy_path) napi_get_value_string_utf8(env, marker, handle->destroy_path, length + 1, &length);
    }
  }
  if (napi_create_object(env, &object) != napi_ok ||
      napi_wrap(env, object, handle, finalize, NULL, NULL) != napi_ok) {
    finalize(env, handle, NULL);
    return NULL;
  }
  return object;
}

static napi_value block_native(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, undefined;
  uint32_t ms;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_uint32(env, arg, &ms) != napi_ok || ms > 5000) return fail(env, "Invalid fixture delay");
  struct timespec remaining = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000000};
  while (nanosleep(&remaining, &remaining) == -1 && errno == EINTR) {}
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value request(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], handler, undefined, block, output;
  fixture_handle *handle;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_unwrap(env, args[0], (void **)&handle) != napi_ok) return fail(env, "Invalid fixture handle");
  if (handle->closed) return fail(env, "Closed fixture");
  if (napi_get_reference_value(env, handle->handler, &handler) != napi_ok ||
      napi_get_undefined(env, &undefined) != napi_ok ||
      napi_create_function(env, "blockNative", NAPI_AUTO_LENGTH, block_native, NULL, &block) != napi_ok) return NULL;
  napi_value call_args[] = {args[1], block};
  return napi_call_function(env, undefined, handler, 2, call_args, &output) == napi_ok ? output : NULL;
}

static napi_value destroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, undefined;
  fixture_handle *handle;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_unwrap(env, arg, (void **)&handle) != napi_ok) return fail(env, "Invalid fixture handle");
  close_handle(handle);
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor props[] = {
    {"create", NULL, create, NULL, NULL, NULL, napi_default, NULL},
    {"request", NULL, request, NULL, NULL, NULL, napi_default, NULL},
    {"destroy", NULL, destroy, NULL, NULL, NULL, napi_default, NULL},
  };
  return napi_define_properties(env, exports, 3, props) == napi_ok ? exports : NULL;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
