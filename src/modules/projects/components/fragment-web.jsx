import React, { useState } from "react";
import { ExternalLink, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";

const FragmentWeb = ({ data }) => {
  const [fragmentKey, setFragmentKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const previewUrl = data?.sandboxUrl?.replace(/^http:\/\//, "https://");

  const onRefresh = () => {
    setFragmentKey((prev) => prev + 1);
  };

  const onCopy = () => {
    if (!previewUrl) return;
    navigator.clipboard.writeText(previewUrl);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <div className="flex flex-col w-full h-full">
      <div className="p-2 border-b bg-sidebar flex items-center gap-x-2">
        <Hint text={"Refresh"} side={"bottom"} align={"start"}>
          <Button size={"sm"} variant={"outline"} onClick={onRefresh}>
            <RefreshCcw />
          </Button>
        </Hint>
        <Hint
          text={copied ? "Copied" : "Click to Copy"}
          side="bottom"
          align="start"
        >
          <Button
            size={"sm"}
            variant={"outline"}
            onClick={onCopy}
            disabled={!previewUrl || copied}
            className={"flex-1 justify-start text-start font-normal"}
          >
            <span className="truncate">{previewUrl}</span>
          </Button>
        </Hint>

        <Hint text={"Open in New Tab"} side="bottom" align="start">
          <Button
            size={"sm"}
            variant={"outline"}
            onClick={() => {
              if (!previewUrl) return;

              window.open(previewUrl, "_blank", "noopener,noreferrer");
            }}
          >
            <ExternalLink />
          </Button>
        </Hint>
      </div>
      <iframe
      key={`${previewUrl || "blank"}-${fragmentKey}`}
      className="w-full h-[calc(100vh-12rem)] border-0"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      loading="lazy"
      src={previewUrl || "about:blank"}
      />
    </div>
  );
};

export default FragmentWeb;
