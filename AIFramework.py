import asyncio
import aiohttp
import csv
from datetime import datetime
import uvloop
import logging


class Config:
    MAX_CONCURRENT = 1
    AGENT_PER_GROUP = 100
    GROUP_CONCURRENT = 1
    TOKEN_REFRESH = 300
    RETRY_BASE_DELAY = 0.1
    MAX_RETRY_ATTEMPTS = 5
    REQUEST_TIMEOUT = 30


class TurboGroupCreator:
    def __init__(self):
        self.connector = aiohttp.TCPConnector(limit=0, ssl=False)
        self.session = None
        self.token = None
        self.semaphore = asyncio.Semaphore(Config.MAX_CONCURRENT)
        self.running = True
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.csv_file = f'group_ids_{timestamp}.csv'

    async def initialize(self):
        self.session = aiohttp.ClientSession(connector=self.connector)
        await self._refresh_token()
        self._init_csv()

    def _init_csv(self):
        with open(self.csv_file, mode='w', newline='') as file:
            writer = csv.writer(file)
            writer.writerow(['Group ID', 'Main Agent ID'])

    async def _refresh_token(self):
        url = 'https://auth-station-staging.aevatar.ai/connect/token'
        data = {
            'grant_type': 'client_credentials',
            'client_id': 'Test',
            'client_secret': 'Test123',
            'scope': 'Aevatar'
        }
        attempt = 0
        while True:
            try:
                async with self.session.post(url, data=data) as resp:
                    resp.raise_for_status()
                    self.token = (await resp.json())['access_token']
                    logging.info("Token刷新成功")
                    return
            except Exception as e:
                attempt += 1
                logging.error(f"Token刷新失败（尝试{attempt}）: {str(e)}")
                await asyncio.sleep(Config.RETRY_BASE_DELAY)
                if attempt >= Config.MAX_RETRY_ATTEMPTS:
                    await self.shutdown()
                    raise

    async def _create_agent(self, agent_type, name):
        url = 'https://station-developer-staging.aevatar.ai/test-client/api/agent'
        headers = {'Authorization': f'Bearer {self.token}'}
        data = {"agentType": agent_type, "name": name}
        attempt = 0

        while self.running:
            try:
                async with self.semaphore:
                    async with self.session.post(url, headers=headers, json=data,
                                                  timeout=aiohttp.ClientTimeout(total=Config.REQUEST_TIMEOUT)) as resp:
                        resp.raise_for_status()
                        return (await resp.json())['data']['id']
            except aiohttp.ClientResponseError as e:
                if e.status == 401:
                    await self._refresh_token()
                    headers['Authorization'] = f'Bearer {self.token}'
                logging.error(f"[{agent_type}] HTTP错误 {e.status}: {await e.response.text()[:200]}")
            except asyncio.TimeoutError:
                logging.error(f"[{agent_type}] 请求超时。")
            except Exception as e:
                if str(e) == "Session is closed":
                    logging.error("会话已关闭，尝试重试。")
                    await self._refresh_session()  # 重新初始化会话
                logging.error(f"[{agent_type}] 请求失败: {str(e)}")

            attempt += 1
            await asyncio.sleep(Config.RETRY_BASE_DELAY)

    async def _create_group(self, main_id, sub_ids):
        url = f'https://station-developer-staging.aevatar.ai/test-client/api/agent/{main_id}/add-subagent'
        headers = {'Authorization': f'Bearer {self.token}'}
        data = {"subAgents": sub_ids}
        attempt = 0

        while self.running:
            try:
                async with self.session.post(url, headers=headers, json=data) as resp:
                    resp.raise_for_status()
                    return True
            except aiohttp.ClientResponseError as e:
                if e.status == 401:
                    await self._refresh_token()
                    headers['Authorization'] = f'Bearer {self.token}'
                logging.error(f"组创建失败 {e.status}: {await e.response.text()[:200]}")
            except Exception as e:
                logging.error(f"组创建异常: {str(e)}")

            attempt += 1
            await asyncio.sleep(Config.RETRY_BASE_DELAY)

    async def _process_single_group(self, group_id):
        timestamp = datetime.now().strftime("%m%d%H%M%S%f")
        prefix = f"group-{group_id}-{timestamp}"

        codeg_tasks = [
            self._create_agent("codegagent", f"{prefix}-codeg-{i}")
            for i in range(50)
        ]
        test_tasks = [
            self._create_agent("agenttest", f"{prefix}-test-{i}")
            for i in range(50)
        ]

        codeg_ids, test_ids = await asyncio.gather(asyncio.gather(*codeg_tasks), asyncio.gather(*test_tasks))

        valid_ids = [cid for cid in codeg_ids if cid] + [tid for tid in test_ids if tid]

        if len(valid_ids) < Config.AGENT_PER_GROUP:
            logging.error(f"组{group_id}无效agent数量: {len(valid_ids)}")
            return None

        if await self._create_group(valid_ids[0], valid_ids[1:]):
            logging.info(f"组{group_id}创建成功！主ID: {valid_ids[0]}")
            self._save_to_csv(group_id, valid_ids[0])
            return valid_ids[0]

    def _save_to_csv(self, group_id, main_id):
        with open(self.csv_file, mode='a', newline='') as file:
            writer = csv.writer(file)
            writer.writerow([group_id, main_id])

    async def turbo_create_groups(self, total_groups):
        start_time = datetime.now()
        tasks = [self._process_single_group(i + 1) for i in range(total_groups)]
        results = await asyncio.gather(*tasks)

        success_count = sum(1 for result in results if result)

        elapsed = (datetime.now() - start_time).total_seconds()
        logging.info(
            f"最终报告 | 成功组: {success_count}/{total_groups} | "
            f"总耗时: {elapsed:.1f}s | "
            f"平均速度: {success_count / elapsed:.2f}组/秒"
        )

    async def _refresh_session(self):
        """重新初始化会话"""
        if self.session:
            await self.session.close()
        self.session = aiohttp.ClientSession(connector=self.connector)

    async def shutdown(self):
        self.running = False
        if self.session:
            await self.session.close()
        if self.connector:
            await self.connector.close()


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler("debug.log"),
            logging.StreamHandler()
        ]
    )

    creator = TurboGroupCreator()
    try:
        await creator.initialize()
        await creator.turbo_create_groups(1)
    finally:
        await creator.shutdown()


if __name__ == '__main__':
    uvloop.install()
    asyncio.run(main())