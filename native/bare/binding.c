// SPDX-License-Identifier: Apache-2.0
#include <bare.h>
#include <dlfcn.h>
#include <js.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct utexo_onchain_handle_s utexo_onchain_handle_t;
typedef struct {
  uint8_t *data;
  size_t len;
} utexo_onchain_buffer_t;

extern utexo_onchain_handle_t *utexo_onchain_create(void);
extern utexo_onchain_buffer_t utexo_onchain_request(
    utexo_onchain_handle_t *handle, const uint8_t *frame, size_t len);
extern void utexo_onchain_free(utexo_onchain_buffer_t buffer);
extern void utexo_onchain_destroy(utexo_onchain_handle_t *handle);

typedef struct {
  utexo_onchain_handle_t *engine;
} wallet_handle_t;

static const js_type_tag_t wallet_tag = {
    UINT64_C(0x5086635712cebf93), UINT64_C(0x086c8e1f4c20aa5e),
};
static const size_t max_frame = 6 * 1024 * 1024;

#ifndef __ANDROID__
static int pin_module(void) {
  // rgb-lib owns a process-wide Tokio runtime. Bare can unload a dylib at
  // worker teardown; its executable code must remain mapped for those threads.
  // RTLD_NOLOAD only accepts the image the loader has already admitted.
  Dl_info image;
  if (dladdr((const void *)&utexo_onchain_create, &image) == 0) return -1;
  void *module = dlopen(image.dli_fname, RTLD_LAZY | RTLD_LOCAL | RTLD_NOLOAD | RTLD_NODELETE);
  if (!module) return -1;
  return dlclose(module);
}
#endif

static void release_handle(wallet_handle_t *handle) {
  if (handle->engine) {
    utexo_onchain_destroy(handle->engine);
    handle->engine = NULL;
  }
}

static void finalize(js_env_t *env, void *data, void *hint) {
  (void)env;
  (void)hint;
  wallet_handle_t *handle = data;
  release_handle(handle);
  free(handle);
}

static js_value_t *create(js_env_t *env, js_callback_info_t *info) {
  (void)info;
  js_value_t *object;
  if (js_create_object(env, &object) != 0 ||
      js_add_type_tag(env, object, &wallet_tag) != 0) return NULL;
  wallet_handle_t *handle = malloc(sizeof(*handle));
  if (!handle) {
    js_throw_error(env, "NATIVE_ALLOCATION", "Unable to allocate a wallet handle.");
    return NULL;
  }
  handle->engine = utexo_onchain_create();
  if (js_wrap(env, object, handle, finalize, NULL, NULL) != 0) {
    finalize(env, handle, NULL);
    return NULL;
  }
  return object;
}

static wallet_handle_t *get_handle(js_env_t *env, js_value_t *value) {
  bool is_object, tagged;
  void *handle;
  if (js_is_object(env, value, &is_object) != 0) return NULL;
  if (!is_object) goto invalid;
  if (js_check_type_tag(env, value, &wallet_tag, &tagged) != 0) return NULL;
  if (!tagged) goto invalid;
  if (js_unwrap(env, value, &handle) != 0) return NULL;
  return handle;
invalid:
  js_throw_type_error(env, "NATIVE_INVALID_HANDLE", "Expected a native wallet handle.");
  return NULL;
}

static js_value_t *request(js_env_t *env, js_callback_info_t *info) {
  js_value_t *args[2];
  size_t argc = 2;
  if (js_get_callback_info(env, info, &argc, args, NULL, NULL) != 0) return NULL;
  if (argc != 2) {
    js_throw_type_error(env, "NATIVE_INVALID_REQUEST", "Expected a wallet handle and request text.");
    return NULL;
  }
  wallet_handle_t *handle = get_handle(env, args[0]);
  if (!handle) return NULL;
  if (!handle->engine) {
    js_throw_error(env, "NATIVE_CLOSED", "The native wallet handle has been closed.");
    return NULL;
  }
  js_value_type_t type;
  size_t len;
  if (js_typeof(env, args[1], &type) != 0) return NULL;
  if (type != js_string) {
    js_throw_type_error(env, "NATIVE_INVALID_REQUEST", "Expected request text.");
    return NULL;
  }
  if (js_get_value_string_utf8(env, args[1], NULL, 0, &len) != 0) return NULL;
  if (len == 0 || len > max_frame) {
    js_throw_range_error(env, "NATIVE_INVALID_REQUEST", "Request text size is out of bounds.");
    return NULL;
  }
  uint8_t *frame = malloc(len);
  if (!frame) {
    js_throw_error(env, "NATIVE_ALLOCATION", "Unable to allocate a wallet request.");
    return NULL;
  }
  size_t written;
  int result = js_get_value_string_utf8(env, args[1], (utf8_t *)frame, len, &written);
  utexo_onchain_buffer_t response = {NULL, 0};
  if (result == 0 && written == len) response = utexo_onchain_request(handle->engine, frame, len);
  for (size_t i = 0; i < len; i++) ((volatile uint8_t *)frame)[i] = 0;
  free(frame);
  if (result != 0) return NULL;
  if (!response.data) {
    release_handle(handle);
    js_throw_error(env, "NATIVE_RUNTIME_TERMINAL", "The native wallet session must be reopened.");
    return NULL;
  }
  js_value_t *output;
  result = js_create_string_utf8(env, (const utf8_t *)response.data, response.len, &output);
  utexo_onchain_free(response);
  return result == 0 ? output : NULL;
}

static js_value_t *destroy(js_env_t *env, js_callback_info_t *info) {
  js_value_t *arg;
  size_t argc = 1;
  if (js_get_callback_info(env, info, &argc, &arg, NULL, NULL) != 0) return NULL;
  if (argc != 1) {
    js_throw_type_error(env, "NATIVE_INVALID_HANDLE", "Expected a native wallet handle.");
    return NULL;
  }
  wallet_handle_t *handle = get_handle(env, arg);
  if (!handle) return NULL;
  release_handle(handle);
  js_value_t *undefined;
  return js_get_undefined(env, &undefined) == 0 ? undefined : NULL;
}

static js_value_t *init(js_env_t *env, js_value_t *exports) {
  // Android embeds DF_1_NODELETE at link time. Its loader may use an APK path.
#ifndef __ANDROID__
  if (pin_module() != 0) {
    js_throw_error(env, "NATIVE_LOAD_FAILED", "Unable to keep the RGB runtime resident.");
    return NULL;
  }
#endif
  const struct {
    const char *name;
    js_function_cb callback;
  } methods[] = {
      {"create", create}, {"request", request}, {"destroy", destroy},
  };
  for (size_t i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
    js_value_t *fn;
    const char *name = methods[i].name;
    if (js_create_function(env, name, strlen(name), methods[i].callback, NULL, &fn) != 0 ||
        js_set_named_property(env, exports, name, fn) != 0) return NULL;
  }
  return exports;
}

BARE_MODULE(utexo_wdk_wallet_rgb, init)
