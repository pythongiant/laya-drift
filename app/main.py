from fastapi import FastAPI

from app.routes.health import router as health_router

app = FastAPI(title="drift")
app.include_router(health_router)
