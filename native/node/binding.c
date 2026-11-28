// SPDX-License-Identifier: Apache-2.0
#include <node_api.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct utexo_node_handle_s utexo_node_handle_t;
typedef struct {
  uint8_t *data;
  size_t len;
} utexo_node_buffer_t;

extern utexo_node_handle_t *utexo_node_create(void);
extern utexo_node_buffer_t utexo_node_request(
    utexo_node_handle_t *handle, const uint8_t *frame, size_t len);
extern void utexo_node_free(utexo_node_buffer_t buffer);
extern void utexo_node_destroy(utexo_node_handle_t *handle);

typedef struct environment_s environment_t;
typedef struct wallet_handle_s wallet_handle_t;
struct wallet_handle_s {
  utexo_node_handle_t *engine;
  environment_t *owner;
  wallet_handle_t *previous;
  wallet_handle_t *next;
};
struct environment_s {
  wallet_handle_t *first;
};

static const napi_type_tag wallet_tag = {
    UINT64_C(0xa3e4c0dc6c194a70), UINT64_C(0xb119db412986fcad),
};
static const size_t max_frame = 6 * 1024 * 1024;
static const size_t max_response = 14 * 1024 * 1024;

static bool checked(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && !pending)
    napi_throw_error(env, "NATIVE_BOUNDARY_FAILED", "The native wallet boundary failed.");
  return false;
}

static int pin_module(void) {
  // rgb-lib's process-wide Tokio runtime can outlive a Node Worker. Keep this
  // admitted image mapped after the worker closes; no new library is selected.
  Dl_info image;
  if (dladdr((const void *)&pin_module, &image) == 0) return -1;
  void *module = dlopen(image.dli_fname, RTLD_LAZY | RTLD_LOCAL | RTLD_NOLOAD | RTLD_NODELETE);
  if (!module) return -1;
  return dlclose(module);
}

static void release_handle(wallet_handle_t *handle) {
  if (handle->engine) {
    utexo_node_destroy(handle->engine);
    handle->engine = NULL;
  }
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  wallet_handle_t *handle = data;
  release_handle(handle);
  if (handle->owner) {
    if (handle->previous) handle->previous->next = handle->next;
    else handle->owner->first = handle->next;
    if (handle->next) handle->next->previous = handle->previous;
  }
  free(handle);
}

static void cleanup_environment(void *data) {
  environment_t *owner = data;
  wallet_handle_t *handle = owner->first;
  // A referenced JS object need not have been collected before worker teardown.
  // Release its wallet lock now; its later wrap finalizer only frees the wrapper.
  while (handle) {
    wallet_handle_t *next = handle->next;
    release_handle(handle);
    handle->owner = NULL;
    handle = next;
  }
  free(owner);
}

static napi_value create(napi_env env, napi_callback_info info) {
  environment_t *owner;
  if (!checked(env, napi_get_cb_info(env, info, NULL, NULL, NULL, (void **)&owner))) return NULL;
  napi_value object;
  if (!checked(env, napi_create_object(env, &object)) ||
      !checked(env, napi_type_tag_object(env, object, &wallet_tag))) return NULL;
  wallet_handle_t *handle = calloc(1, sizeof(*handle));
  if (!handle) {
    napi_throw_error(env, "NATIVE_ALLOCATION", "Unable to allocate a wallet handle.");
    return NULL;
  }
  handle->engine = utexo_node_create();
  if (!handle->engine) {
    free(handle);
    napi_throw_error(env, "NATIVE_ALLOCATION", "Unable to allocate a wallet engine.");
    return NULL;
  }
  if (!checked(env, napi_wrap(env, object, handle, finalize, NULL, NULL))) {
    finalize(env, handle, NULL);
    return NULL;
  }
  handle->owner = owner;
  handle->next = owner->first;
  if (owner->first) owner->first->previous = handle;
  owner->first = handle;
  return object;
}

static wallet_handle_t *get_handle(napi_env env, napi_value value, environment_t *owner) {
  napi_valuetype type;
  bool tagged;
  void *handle;
  if (!checked(env, napi_typeof(env, value, &type))) return NULL;
  if (type != napi_object) goto invalid;
  if (!checked(env, napi_check_object_type_tag(env, value, &wallet_tag, &tagged))) return NULL;
  if (!tagged) goto invalid;
  if (!checked(env, napi_unwrap(env, value, &handle))) return NULL;
  // Separately loaded addon copies use the same public type tag. A handle must
  // still belong to this module instance before entering its Rust implementation.
  if (((wallet_handle_t *)handle)->owner != owner) goto invalid;
  return handle;
invalid:
  napi_throw_type_error(env, "NATIVE_INVALID_HANDLE", "Expected a native wallet handle.");
  return NULL;
}

static napi_value request(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = 2;
  environment_t *owner;
  if (!checked(env, napi_get_cb_info(env, info, &argc, args, NULL, (void **)&owner))) return NULL;
  if (argc != 2) {
    napi_throw_type_error(env, "NATIVE_INVALID_REQUEST", "Expected a wallet handle and request text.");
    return NULL;
  }
  wallet_handle_t *handle = get_handle(env, args[0], owner);
  if (!handle) return NULL;
  if (!handle->engine) {
    napi_throw_error(env, "NATIVE_CLOSED", "The native wallet handle has been closed.");
    return NULL;
  }
  napi_valuetype type;
  size_t len;
  if (!checked(env, napi_typeof(env, args[1], &type))) return NULL;
  if (type != napi_string) {
    napi_throw_type_error(env, "NATIVE_INVALID_REQUEST", "Expected request text.");
    return NULL;
  }
  if (!checked(env, napi_get_value_string_utf8(env, args[1], NULL, 0, &len))) return NULL;
  if (len == 0 || len > max_frame) {
    napi_throw_range_error(env, "NATIVE_INVALID_REQUEST", "Request text size is out of bounds.");
    return NULL;
  }
  // Node-API includes a trailing NUL in the destination capacity, but Rust sees
  // precisely the UTF-8 bytes. Embedded NULs remain data and fail JSON validation.
  uint8_t *frame = malloc(len + 1);
  if (!frame) {
    napi_throw_error(env, "NATIVE_ALLOCATION", "Unable to allocate a wallet request.");
    return NULL;
  }
  size_t written;
  napi_status status = napi_get_value_string_utf8(env, args[1], (char *)frame, len + 1, &written);
  utexo_node_buffer_t response = {NULL, 0};
  if (status == napi_ok && written == len) response = utexo_node_request(handle->engine, frame, len);
  for (size_t i = 0; i <= len; i++) ((volatile uint8_t *)frame)[i] = 0;
  free(frame);
  if (!checked(env, status)) return NULL;
  if (!response.data || response.len == 0 || response.len > max_response) {
    utexo_node_free(response);
    release_handle(handle);
    napi_throw_error(env, "NATIVE_RUNTIME_TERMINAL", "The native wallet session must be reopened.");
    return NULL;
  }
  napi_value output;
  status = napi_create_string_utf8(env, (const char *)response.data, response.len, &output);
  utexo_node_free(response);
  return checked(env, status) ? output : NULL;
}

static napi_value destroy(napi_env env, napi_callback_info info) {
  napi_value arg;
  size_t argc = 1;
  environment_t *owner;
  if (!checked(env, napi_get_cb_info(env, info, &argc, &arg, NULL, (void **)&owner))) return NULL;
  if (argc != 1) {
    napi_throw_type_error(env, "NATIVE_INVALID_HANDLE", "Expected a native wallet handle.");
    return NULL;
  }
  wallet_handle_t *handle = get_handle(env, arg, owner);
  if (!handle) return NULL;
  release_handle(handle);
  napi_value undefined;
  return checked(env, napi_get_undefined(env, &undefined)) ? undefined : NULL;
}

NAPI_MODULE_INIT() {
  if (pin_module() != 0) {
    napi_throw_error(env, "NATIVE_LOAD_FAILED", "Unable to keep the RGB runtime resident.");
    return NULL;
  }
  environment_t *owner = calloc(1, sizeof(*owner));
  if (!owner) {
    napi_throw_error(env, "NATIVE_ALLOCATION", "Unable to allocate the native environment.");
    return NULL;
  }
  if (!checked(env, napi_add_env_cleanup_hook(env, cleanup_environment, owner))) {
    free(owner);
    return NULL;
  }
  const napi_property_descriptor methods[] = {
      {"create", NULL, create, NULL, NULL, NULL, napi_default, owner},
      {"request", NULL, request, NULL, NULL, NULL, napi_default, owner},
      {"destroy", NULL, destroy, NULL, NULL, NULL, napi_default, owner},
  };
  if (!checked(env, napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods))) return NULL;
  return exports;
}
