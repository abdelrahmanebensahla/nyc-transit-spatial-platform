# Long-lived poller worker. Deliberately not Vercel: Cron on Hobby runs once a
# day and even Pro floors at one minute, against a 30-second target.
FROM python:3.12-slim

WORKDIR /app

COPY poller/requirements.txt ./poller/requirements.txt
RUN pip install --no-cache-dir -r poller/requirements.txt

# loader/config.py is imported by the poller for env handling.
COPY loader/config.py ./loader/config.py
COPY poller/ ./poller/

ENV PYTHONUNBUFFERED=1
CMD ["python", "poller/poll.py"]
