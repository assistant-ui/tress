const BRANDS = [
  { icon: "claude", name: "Anthropic", models: /\b(?:claude|anthropic)\b/i },
  { icon: "gemini", name: "Google", models: /\b(?:gemini|gemma|google)\b/i },
  { icon: "deepseek", name: "DeepSeek", models: /\bdeepseek\b/i },
  { icon: "qwen", name: "Qwen", models: /\b(?:qwen\d*|qwq|qvq)\b/i },
  {
    icon: "mistral",
    name: "Mistral",
    models:
      /\b(?:mistral|mixtral|ministral|codestral|devstral|magistral|pixtral)\b/i,
  },
  { icon: "meta", name: "Meta", models: /\b(?:llama\d*|meta)\b/i },
  { icon: "grok", name: "xAI", models: /\b(?:grok|xai|x-ai)\b/i },
  { icon: "cohere", name: "Cohere", models: /\b(?:cohere|command|aya)\b/i },
  { icon: "moonshot", name: "Moonshot", models: /\b(?:kimi|moonshot)\b/i },
  {
    icon: "perplexity",
    name: "Perplexity",
    models: /\b(?:perplexity|sonar)\b/i,
  },
  { icon: "zai", name: "Z.ai", models: /\b(?:glm|zhipu|z-ai|z\.ai)\b/i },
  {
    icon: "openai",
    name: "OpenAI",
    models: /\b(?:openai|gpt|chatgpt|codex|o\d+)\b/i,
  },
] as const;

/** Recognizes model families, including namespaced gateway/Bedrock IDs. */
export const modelBrand = (model: string) =>
  BRANDS.find((brand) => brand.models.test(model));

export function ModelBadge({ model }: { model?: string }) {
  const brand = model ? modelBrand(model) : undefined;
  const icon = `url("/icons/models/${brand?.icon ?? "model"}.svg")`;
  const label = model ?? "connecting…";

  return (
    <span
      className="model-badge"
      title={brand ? `${brand.name} · ${label}` : label}
      aria-label={brand ? `${brand.name} · ${label}` : label}
    >
      <span
        className="model-provider-icon"
        aria-hidden="true"
        style={{ maskImage: icon, WebkitMaskImage: icon }}
      />
      <span className="model-name">{label}</span>
    </span>
  );
}
