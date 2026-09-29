# Crusoe

Crusoe is an AI cloud. Its Managed Inference service runs open models behind an OpenAI-compatible
API. Lecturn runs Crusoe models through [OpenCode](./providers-opencode.md), which already knows
Crusoe's endpoint and reads your key from the `CRUSOE_API_KEY` environment variable.

Crusoe needs OpenCode 1.14.19 or newer on the connected environment. With a remote environment,
that environment's OpenCode installation applies, not the one on your desktop or phone.

## Create an API key

Open the Crusoe console, go to **Foundry** > **API keys**
([console.crusoecloud.com/foundry/api-keys](https://console.crusoecloud.com/foundry/api-keys)),
and create a key. Crusoe shows the key only once, so copy it before you close the dialog.

Crusoe bills usage to the account that owns the key.

## Add Crusoe

1. Open **Settings** > **Providers** and select the environment.
2. Choose **Add provider** (the + button), then choose **Crusoe**.
3. Keep the label **Crusoe** or enter your own.
4. On the last step, paste your API key.
5. Choose **Add instance**.

Add the instance from the web or desktop app. The mobile app cannot add provider instances, but
once the instance exists you can use Crusoe models from web, desktop, and mobile.

## What the instance contains

The Crusoe instance is an OpenCode instance with two environment variables:

| Variable                  | Value                              | Purpose                                    |
| ------------------------- | ---------------------------------- | ------------------------------------------ |
| `CRUSOE_API_KEY`          | Your API key                       | Authenticates with Crusoe                  |
| `OPENCODE_CONFIG_CONTENT` | `{"enabled_providers":["crusoe"]}` | Limits this instance to Crusoe models only |

Lecturn stores the API key as a secret and never sends it back to clients. You can view and edit
both variables in the instance's environment variables section. Removing the instance removes the
key.

## Models

Crusoe models appear in the model picker under the instance's label. Their model IDs start with
`crusoe/`. The list comes from OpenCode's model catalog, which can lag behind Crusoe: it may
include models Crusoe has retired, which fail with "Model not found", and miss newly added ones.

Models that work well:

- GPT OSS 120B (`crusoe/openai/gpt-oss-120b`), which Crusoe recommends for tool-heavy coding
- Nemotron 3 Super (`crusoe/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`)
- Gemma 4 (`crusoe/google/gemma-4-31b-it`)
- Kimi K2.6 (`crusoe/moonshotai/Kimi-K2.6`), when Crusoe has capacity for it

Approvals, permission modes, and Stop work the same as any OpenCode instance. See
[OpenCode](./providers-opencode.md).

## Troubleshooting

If no Crusoe models appear:

- Check that `CRUSOE_API_KEY` is set and has no typos. OpenCode hides providers that have no key.
- Check that OpenCode is version 1.14.19 or newer.

After you edit the key, choose **Refresh provider status** in **Settings** > **Providers** to load
the model list again.
