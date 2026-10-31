import logging
import uuid

from .base import SmsProvider

log = logging.getLogger("sms.fake")


class FakeSmsProvider(SmsProvider):
    sent: list[tuple[str, str]] = []

    def send(self, to: str, body: str) -> str:
        FakeSmsProvider.sent.append((to, body))
        log.info("SMS -> %s: %s", to, body)
        return str(uuid.uuid4())
