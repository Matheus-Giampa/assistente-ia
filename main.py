from fastapi import FastAPI

app = FastAPI(title="API Vozes", version="0.1.0")

@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "Servidor rodando liso"}