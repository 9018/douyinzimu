import os
from urllib.parse import quote, urlsplit, urlunsplit
import xml.etree.ElementTree as ET

import requests
from loguru import logger


class WebDAVClient:
    def __init__(
        self,
        base_url: str,
        username: str = "",
        password: str = "",
        base_path: str = "",
    ) -> None:
        if not base_url:
            raise ValueError("WebDAV 地址不能为空")

        self.base_url = base_url.rstrip("/")
        self.base_path = base_path.strip("/")
        self.session = requests.Session()
        if username:
            self.session.auth = (username, password)

    def test_connection(self) -> bool:
        response = self.session.request(
            "PROPFIND",
            self._build_url(self.base_path),
            headers={"Depth": "0"},
            data=self._propfind_body(),
            timeout=60,
        )
        return response.status_code in (200, 207)

    def list_entries(self, remote_dir: str = "") -> list[dict[str, str | bool | int]]:
        remote_dir = remote_dir.strip("/")
        full_path = "/".join(part for part in [self.base_path, remote_dir] if part)
        response = self.session.request(
            "PROPFIND",
            self._build_url(full_path),
            headers={"Depth": "1"},
            data=self._propfind_body(),
            timeout=60,
        )

        if response.status_code not in (200, 207):
            raise RuntimeError(
                f"WebDAV 目录读取失败: HTTP {response.status_code} - {response.text[:200]}"
            )

        namespace = {"d": "DAV:"}
        root = ET.fromstring(response.text)
        items: list[dict[str, str | bool | int]] = []
        current_href = self._normalize_href(full_path)

        for node in root.findall("d:response", namespace):
            href = node.findtext("d:href", default="", namespaces=namespace)
            decoded_href = requests.utils.unquote(href)
            normalized_href = decoded_href.rstrip("/")
            if normalized_href == current_href:
                continue

            collection = node.find(
                "d:propstat/d:prop/d:resourcetype/d:collection", namespace
            )
            content_length = node.findtext(
                "d:propstat/d:prop/d:getcontentlength", default="", namespaces=namespace
            )

            relative_path = normalized_href
            if self.base_path:
                base_href = self._normalize_href(self.base_path)
                if normalized_href.startswith(base_href):
                    relative_path = normalized_href[len(base_href) :].lstrip("/")

            name = os.path.basename(relative_path.strip("/")) or "/"
            items.append(
                {
                    "name": name,
                    "path": relative_path.strip("/"),
                    "is_dir": collection is not None,
                    "size": int(content_length or 0) if content_length.isdigit() else 0,
                }
            )

        items.sort(key=lambda item: (not bool(item["is_dir"]), str(item["path"]).lower()))
        return items

    def upload_file(self, local_path: str, remote_relative_path: str) -> str:
        if not os.path.exists(local_path):
            raise FileNotFoundError(f"文件不存在: {local_path}")

        remote_relative_path = remote_relative_path.strip("/").replace("\\", "/")
        if not remote_relative_path:
            raise ValueError("远程路径不能为空")

        remote_full_path = "/".join(
            part for part in [self.base_path, remote_relative_path] if part
        )

        parent_dir = os.path.dirname(remote_full_path)
        if parent_dir:
            self._ensure_directory(parent_dir)

        remote_url = self._build_url(remote_full_path)
        with open(local_path, "rb") as fh:
            response = self.session.put(remote_url, data=fh, timeout=300)

        if response.status_code not in (200, 201, 204):
            raise RuntimeError(
                f"WebDAV 上传失败: HTTP {response.status_code} - {response.text[:200]}"
            )

        logger.info(f"✓ WebDAV 上传完成: {remote_relative_path}")
        return remote_full_path

    def create_directory(self, remote_relative_dir: str) -> str:
        remote_relative_dir = remote_relative_dir.strip("/").replace("\\", "/")
        if not remote_relative_dir:
            raise ValueError("远程目录不能为空")

        remote_full_path = "/".join(
            part for part in [self.base_path, remote_relative_dir] if part
        )
        self._ensure_directory(remote_full_path)
        logger.info(f"✓ WebDAV 目录已创建: {remote_relative_dir}")
        return remote_full_path

    def rename_path(self, old_relative_path: str, new_relative_path: str) -> str:
        old_relative_path = old_relative_path.strip("/").replace("\\", "/")
        new_relative_path = new_relative_path.strip("/").replace("\\", "/")
        if not old_relative_path or not new_relative_path:
            raise ValueError("原路径和新路径不能为空")

        old_full_path = "/".join(
            part for part in [self.base_path, old_relative_path] if part
        )
        new_full_path = "/".join(
            part for part in [self.base_path, new_relative_path] if part
        )
        parent_dir = os.path.dirname(new_full_path)
        if parent_dir:
            self._ensure_directory(parent_dir)

        response = self.session.request(
            "MOVE",
            self._build_url(old_full_path),
            headers={
                "Destination": self._build_url(new_full_path),
                "Overwrite": "T",
            },
            timeout=120,
        )
        if response.status_code not in (200, 201, 204):
            raise RuntimeError(
                f"WebDAV 重命名失败: HTTP {response.status_code} - {response.text[:200]}"
            )

        logger.info(f"✓ WebDAV 已重命名: {old_relative_path} -> {new_relative_path}")
        return new_full_path

    def delete_path(self, relative_path: str) -> str:
        relative_path = relative_path.strip("/").replace("\\", "/")
        if not relative_path:
            raise ValueError("远程路径不能为空")

        full_path = "/".join(part for part in [self.base_path, relative_path] if part)
        response = self.session.request(
            "DELETE",
            self._build_url(full_path),
            timeout=120,
        )
        if response.status_code not in (200, 204):
            raise RuntimeError(
                f"WebDAV 删除失败: HTTP {response.status_code} - {response.text[:200]}"
            )

        logger.info(f"✓ WebDAV 已删除: {relative_path}")
        return full_path

    def _ensure_directory(self, remote_dir: str) -> None:
        current = []
        for part in remote_dir.split("/"):
            if not part:
                continue
            current.append(part)
            url = self._build_url("/".join(current))
            response = self.session.request("MKCOL", url, timeout=60)
            if response.status_code in (200, 201, 204, 405):
                continue
            raise RuntimeError(
                f"WebDAV 创建目录失败: HTTP {response.status_code} - {response.text[:200]}"
            )

    def _build_url(self, remote_path: str) -> str:
        split = urlsplit(self.base_url)
        encoded_path = "/".join(quote(part) for part in remote_path.split("/") if part)
        base_path = split.path.rstrip("/")
        final_path = "/".join(part for part in [base_path, encoded_path] if part)
        if not final_path.startswith("/"):
            final_path = f"/{final_path}"
        return urlunsplit((split.scheme, split.netloc, final_path, "", ""))

    def _normalize_href(self, remote_path: str) -> str:
        split = urlsplit(self._build_url(remote_path))
        return requests.utils.unquote(split.path).rstrip("/")

    @staticmethod
    def _propfind_body() -> str:
        return """<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype />
  </d:prop>
</d:propfind>"""
