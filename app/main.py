from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from app.db.session import get_session_factory
from app.services.errors    import DomainError

app = FastAPI(title='Report Agent | 2026-11-20 민준캉', version='2.0.0')

@app.exception_handler(DomainError)
def on_domain_error(request:Request, exc:DomainError):
    return JSONResponse(status_code=exc.status,
                        content={'error':{'code':exc.code,
                                          'message':exc.message,
                                          'details':{}}})

