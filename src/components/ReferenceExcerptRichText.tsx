import { RichText } from "./RichText";

export default function ReferenceExcerptRichText({ source }: { source: string }) {
  return <RichText source={source} mode="comment" />;
}
