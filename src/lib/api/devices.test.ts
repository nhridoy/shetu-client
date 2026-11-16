import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), version: vi.fn() }));
vi.mock("./http", () => ({ httpRequest: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.version }));

import { devicesApi, reportDevice } from "./devices";
import { httpRequest } from "./http";

const request = vi.mocked(httpRequest);
const ok = (body: unknown = null, status = 200) => ({
  status,
  body: body === null ? "" : JSON.stringify({ data: body }),
});

beforeEach(() => {
  request.mockReset();
  h.invoke.mockReset();
  h.version.mockReset();
});

describe("devices API", () => {
  it("lists devices", async () => {
    request.mockResolvedValue(ok([{ device_id: "d1", current: true }]));
    await expect(devicesApi.list()).resolves.toEqual([
      { device_id: "d1", current: true },
    ]);
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/me/devices",
      undefined,
    );
  });

  it("updates, renames and revokes", async () => {
    request.mockResolvedValue(ok(null, 204));
    await devicesApi.updateCurrent({
      name: "pc",
      platform: "linux",
      app_version: "1",
    });
    expect(request).toHaveBeenLastCalledWith(
      "PUT",
      "/api/v1/me/devices/current",
      {
        name: "pc",
        platform: "linux",
        app_version: "1",
      },
    );
    await devicesApi.rename("d 2", "Work");
    expect(request).toHaveBeenLastCalledWith(
      "PATCH",
      "/api/v1/me/devices/d%202",
      { name: "Work" },
    );
    await devicesApi.revoke("d2");
    expect(request).toHaveBeenLastCalledWith(
      "DELETE",
      "/api/v1/me/devices/d2",
      undefined,
    );
    request.mockResolvedValue(ok({ revoked: 3 }));
    await expect(devicesApi.revokeOthers()).resolves.toEqual({ revoked: 3 });
    expect(request).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/me/devices/revoke-others",
      undefined,
    );
  });

  it("surfaces server errors", async () => {
    request.mockResolvedValue({
      status: 404,
      body: '{"error":{"code":"NOT_FOUND","message":"device not found"}}',
    });
    await expect(devicesApi.revoke("x")).rejects.toThrow("device not found");
  });

  it("reportDevice sends name, platform and version and never throws", async () => {
    h.invoke.mockResolvedValue({ name: "nahid-laptop", platform: "linux" });
    h.version.mockResolvedValue("0.0.16");
    request.mockResolvedValue(ok(null, 204));
    await reportDevice();
    expect(request).toHaveBeenCalledWith("PUT", "/api/v1/me/devices/current", {
      name: "nahid-laptop",
      platform: "linux",
      app_version: "0.0.16",
    });
    request.mockRejectedValue(new Error("offline"));
    await expect(reportDevice()).resolves.toBeUndefined();
  });
});
