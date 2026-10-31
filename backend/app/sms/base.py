from abc import ABC, abstractmethod


class SmsProvider(ABC):
    """Couche d'abstraction: passerelle locale, Twilio ou téléphone Android."""

    @abstractmethod
    def send(self, to: str, body: str) -> str:
        """Envoie un SMS et retourne un identifiant de message."""
