import { useEffect, useState } from "react";
import type { UpdateStatus } from "@shared/types";
import { Footer } from "@renderer/shared/ui/Footer";

/** Footer readout: the app version, which also checks for updates and offers
 *  a one-click install when a newer release exists. */
export function VersionStatus() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    void window.api.update.get().then((res) => {
      setVersion(res.version);
      setStatus(res.status);
    });
    void window.api.update.check();
    return window.api.update.onStatus(setStatus);
  }, []);

  if (status.state === "available") {
    return (
      <Footer.Button
        onClick={() => void window.api.update.install()}
        title={`Download and install ${status.version}`}
      >
        New version {status.version} — Update
      </Footer.Button>
    );
  }
  if (status.state === "downloading" || status.state === "ready") {
    return (
      <Footer.Label>
        {status.state === "ready"
          ? "Restarting…"
          : `Updating… ${status.percent}%`}
      </Footer.Label>
    );
  }
  if (status.state === "error") {
    return (
      <Footer.Button
        onClick={() => void window.api.update.check()}
        title={status.message}
      >
        v{version} — Update check failed, retry
      </Footer.Button>
    );
  }
  return (
    <Footer.Label>
      {version ? `v${version}` : ""}
      {status.state === "checking" ? " · checking…" : ""}
    </Footer.Label>
  );
}
