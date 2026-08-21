from functools import lru_cache

from pydantic import PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Infra
    database_url: PostgresDsn
    gemini_api_key: str

    # Connection Pool — ver database.py pro racional por trás desses números
    db_pool_min_size: int = 2
    db_pool_max_size: int = 10
    db_command_timeout: float = 5.0  # segundos por query individual
    db_connect_timeout: float = 5.0  # segundos pra abrir conexão nova / fechar o pool

    # Auth lockout (item 5 do briefing) — já centralizado aqui pra não
    # espalhar magic number quando o módulo de auth for escrito
    max_login_attempts: int = 5
    lockout_minutes: int = 15


@lru_cache
def get_settings() -> Settings:
    # lru_cache garante que o .env só é parseado uma vez por processo
    return Settings()
    # JWT (stateless — sem tabela de sessão, só assinatura + expiração)
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60