import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadPicker } from "./UploadSheet";

test("upload begins with audio and paste transcript choices", () => {
  const markup = renderToStaticMarkup(<UploadPicker onChoose={() => {}} />);
  expect(markup).toContain(">Audio file</button>");
  expect(markup).toContain(">Paste a transcript</button>");
});
