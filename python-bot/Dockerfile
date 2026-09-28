FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ENABLE_HEALTH_SERVER=true
WORKDIR /app
COPY python-bot/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 bot
COPY --chown=bot:bot python-bot/main.py ./
USER bot
EXPOSE 10000
CMD ["python", "main.py"]
