"""DMXAPI OpenAI 兼容视觉模型客户端。"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


class DMXAPIVisionClient:
    """DMXAPI 视觉识别客户端。"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "glm-4.6v",
        temperature: float = 0.1,
        max_tokens: int = 1000,
        retry_times: int = 3,
        retry_delay: float = 1.0,
        base_url: str = "https://www.dmxapi.cn/v1",
    ):
        self.api_key = (
            api_key
            or os.getenv("DMXAPI_API_KEY")
            or os.getenv("CLAUDE_API_KEY")
        )
        if not self.api_key:
            raise ValueError(
                "API key not provided. Set DMXAPI_API_KEY, or pass api_key parameter"
            )

        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.retry_times = retry_times
        self.retry_delay = retry_delay
        self.base_url = (base_url or os.getenv("DMXAPI_BASE_URL") or "https://www.dmxapi.cn/v1").rstrip("/")
        self.api_url = f"{self.base_url}/chat/completions"

        self.total_requests = 0
        self.total_time = 0.0
        self.total_input_tokens = 0
        self.total_output_tokens = 0

    def _encode_image(self, image_path: str) -> tuple[str, str]:
        media_type, _ = mimetypes.guess_type(image_path)
        if not media_type or not media_type.startswith("image/"):
            media_type = "image/jpeg"

        with open(image_path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("utf-8")

        return media_type, encoded

    @staticmethod
    def _extract_text(response_json: Dict[str, Any]) -> str:
        choices = response_json.get("choices", [])
        if not choices:
            return ""

        message = choices[0].get("message", {})
        content = message.get("content", "")
        if isinstance(content, str):
            return content.strip()

        texts: List[str] = []
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    texts.append(str(part.get("text", "")))
        return "".join(texts).strip()

    def recognize(self, image_path: str, prompt: str) -> Dict[str, Any]:
        try:
            media_type, base64_image = self._encode_image(image_path)
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to encode image: {e}",
                "time": 0.0,
            }

        payload = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt,
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{media_type};base64,{base64_image}"
                            },
                        },
                    ],
                }
            ],
        }

        request = urllib.request.Request(
            self.api_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )

        for attempt in range(self.retry_times):
            try:
                start_time = time.time()
                with urllib.request.urlopen(request) as response:
                    raw_body = response.read().decode("utf-8")
                elapsed_time = time.time() - start_time

                response_json = json.loads(raw_body)
                response_text = self._extract_text(response_json)
                usage = response_json.get("usage", {})
                usage_info = {
                    "input_tokens": int(usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0) or 0),
                    "output_tokens": int(usage.get("completion_tokens", 0) or usage.get("output_tokens", 0) or 0),
                }

                self.total_requests += 1
                self.total_time += elapsed_time
                self.total_input_tokens += usage_info["input_tokens"]
                self.total_output_tokens += usage_info["output_tokens"]

                return {
                    "success": True,
                    "response": response_text,
                    "time": elapsed_time,
                    "usage": usage_info,
                }
            except urllib.error.HTTPError as e:
                elapsed_time = time.time() - start_time if "start_time" in locals() else 0.0
                error_body = ""
                try:
                    error_body = e.read().decode("utf-8")
                except Exception:
                    error_body = str(e)

                error_msg = f"HTTPError {e.code}: {error_body}"
                if e.code == 403:
                    error_msg += (
                        " | DMXAPI 返回 403，通常表示 key 无权限、账户未开通对应模型，"
                        "或 model 名称不在当前账号可用范围内。"
                    )
                is_unrecoverable = e.code in {401, 403}
                if e.code == 503 and "无可用渠道" in error_body:
                    is_unrecoverable = True
                    error_msg += (
                        " | 当前令牌分组下该模型没有可用渠道。"
                        "请更换模型，或在平台后台切换到有该模型通道的分组。"
                    )

                if attempt < self.retry_times - 1 and not is_unrecoverable:
                    print(f"Attempt {attempt + 1} failed: {error_msg}. Retrying...")
                    time.sleep(self.retry_delay)
                    continue
                return {
                    "success": False,
                    "error": error_msg,
                    "time": elapsed_time,
                }
            except Exception as e:
                error_msg = f"Exception: {e}"
                if attempt < self.retry_times - 1:
                    print(f"Attempt {attempt + 1} failed: {error_msg}. Retrying...")
                    time.sleep(self.retry_delay)
                    continue
                return {
                    "success": False,
                    "error": error_msg,
                    "time": 0.0,
                }

        return {
            "success": False,
            "error": "Max retries exceeded",
            "time": 0.0,
        }

    def get_statistics(self) -> Dict[str, Any]:
        avg_time = self.total_time / self.total_requests if self.total_requests > 0 else 0.0
        return {
            "total_requests": self.total_requests,
            "total_time": self.total_time,
            "avg_time_per_request": avg_time,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "avg_input_tokens": self.total_input_tokens / self.total_requests if self.total_requests > 0 else 0,
            "avg_output_tokens": self.total_output_tokens / self.total_requests if self.total_requests > 0 else 0,
        }
