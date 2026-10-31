import os

from .base import SmsProvider
from .fake import FakeSmsProvider


def get_sms_provider() -> SmsProvider:
    name = os.getenv("SMS_PROVIDER", "fake")
    if name == "fake":
        return FakeSmsProvider()
    raise ValueError(f"Fournisseur SMS inconnu: {name}")
