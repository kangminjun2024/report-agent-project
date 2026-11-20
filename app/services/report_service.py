"""Report Service: 6종 보고서 공통 CRUD/버전/동기화. Repository는 DB, Service는 업무 규칙."""

from datetime import datetime, date
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.config import settings,at_least
from app.models.report import Report, ReportCategory, ReportEmbedding, PromptVersion, DETAIL_MODELS
from app.repositories import report_repository as repo
from app.integrations import embedding_client as emb
from app.services.errors import DomainError
from app.schemas.report import ReportCreate, DETAIL_SCHEMAS
from pydantic import ValidationError

INPUT_FIELDS={
    'EXPERIMENT':{'experiment_date','hypothesis','result_summary'},
    'DAILY_WORK':{'work_date','progress','blockers'},
    'RESEARCH_PLAN':{'research_goal','methodology','target_date'},
    'DATA_PROCESSING':{'dataset_name','processing_steps','quality_notes'},
    'PROMPT':{'purpose','prompt_text'},
    'MEETING':{'meeting_at','attendees','decisions'},
}

OPTIONAL={'DAILY_WORK':{'blockers'},'DATA_PROCESSING':{'quality_notes'}}

DATE_FIELDS={'experiment_date','work_date','target_date'}

TIME_FIELDS={'meeting_at'}

def validate_details(code:str,details:dict,content:str|None=None)->dict:
    """카테고리별 Detail 스키마. Intermediate부터 Pydantic 세부 Model로 검증합니다."""
    needed=INPUT_FIELDS.get(code)
    if needed is None:raise DomainError(422,'VALIDATION_ERROR','알 수 없는 보고서 종류입니다.')
    if not isinstance(details,dict):raise DomainError(422,'VALIDATION_ERROR','details는 객체여야 합니다.')
    required=needed-OPTIONAL.get(code,set())
    missing=required-details.keys()
    extras=details.keys()-needed
    if missing or extras:
        raise DomainError(422,'VALIDATION_ERROR',f'details 필드 누락/초과: {sorted(missing)} / {sorted(extras)}')
    result={}
    for k in needed:
        v=details.get(k,'' if k in OPTIONAL.get(code,set()) else None)
        if k in DATE_FIELDS:
            try: result[k]=date.fromisoformat(v) if isinstance(v,str) else v
            except (TypeError,ValueError):raise DomainError(422,'VALIDATION_ERROR',f'{k}는 YYYY-MM-DD 형식이어야 합니다.')
            if not isinstance(result[k],date) or isinstance(result[k],datetime):
                raise DomainError(422,'VALIDATION_ERROR',f'{k} 날짜 형식 오류')
        elif k in TIME_FIELDS:
            try: d=datetime.fromisoformat(v.replace('Z','+00:00')) if isinstance(v,str) else v
            except (TypeError,ValueError):raise DomainError(422,'VALIDATION_ERROR',f'{k} ISO 8601 형식 오류')
            if not isinstance(d,datetime) or d.tzinfo is None:
                raise DomainError(422,'VALIDATION_ERROR',f'{k}에 시간대가 필요합니다.')
            result[k]=d
        elif not isinstance(v,str) or (k not in OPTIONAL.get(code,set()) and not v.strip()):
            raise DomainError(422,'VALIDATION_ERROR',f'{k}는 비어 있지 않은 문자열이어야 합니다.')
        else: result[k]=v
    if code=='PROMPT' and content is not None and content !=result['prompt_text']:
        raise DomainError(422,'VALIDATION_ERROR','Prompt content와 details.prompt_text는 동일해야 합니다.')
    if at_least('intermediate'):
        try:
            # data validation 결과는 같은 자료형의 date/datetime 객체를 보유합니다.
            return DETAIL_SCHEMAS[code].model_validate(details).model_dump()
        except ValidationError as e:
            raise DomainError(422,'VALIDATION_ERROR','카테고리별 상세 속성을 확인하세요.') from e
    return result

def encode_overview(overview:str)->list[float]:
    try: return emb.encode([overview],kind='passage')[0]
    except Exception as e:raise DomainError(503,'EMBEDDING_UNAVAILABLE','E5 Embedding을 생성하지 못했습니다.') from e

def categories(db:Session)->dict:
    rows=db.scalars(select(ReportCategory).order_by(ReportCategory.category_id)).all()
    return {'items':[{'category_id':r.category_id,'code':r.code,'name':r.name,'description':r.description} for r in rows]}

def create_report(db:Session,data:ReportCreate)->dict:
    details=validate_details(data.category_code,data.details,data.content)
    vector=encode_overview(data.overview) # DB 트랜잭션 시작 전에 느린 외부 모델 연산 수행
    with db.begin():
        category=repo.category_for_code(db,data.category_code)
        row=Report(category_id=category.category_id,overview=data.overview,index_status='ready',revision=1)
        db.add(row);db.flush() # INSERT가 실행되어 서버가 부여한 ID 사용. commit 전에는 미확정.
        detail_kwargs={k:v for k,v in details.items() if k!='prompt_text'}
        if data.category_code=='PROMPT':detail_kwargs['active_version_no']=1
        detail=DETAIL_MODELS[data.category_code](report_id=row.report_id,title=data.title,
               content=data.content,author=data.author,**detail_kwargs)
        db.add(detail);db.flush() # PromptVersion의 FK가 참조할 Prompt 상세 행 생성.
        if data.category_code=='PROMPT':
            db.add(PromptVersion(report_id=row.report_id,version_no=1,prompt_text=details['prompt_text']))
        db.add(ReportEmbedding(report_id=row.report_id,embedding=vector,
                    model_name=settings.embedding_model,overview_hash=emb.overview_hash(data.overview),indexed_revision=1))
        rid=row.report_id
    return {'report_id':rid,'category_code':data.category_code,'title':data.title,
            'author':data.author,'revision':1,'index_status':'ready','embedding_model':settings.embedding_model}

def get_report(db:Session,rid:int)->dict:
    return repo.read_report(db,rid)

def list_reports(db:Session,title:str|None,limit:int,offset:int,
                 category_code:str|None=None,updated_after:datetime|None=None):
    return repo.list_reports(db,title,limit,offset,category_code,updated_after)
