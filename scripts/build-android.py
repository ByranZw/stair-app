# -*- coding: utf-8 -*-
"""用本应用官方原生包、工程配置及最新导出资源本地重建APK；签名配置留在仓库外。"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

APKTOOL_SHA256 = 'dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423'
ANDROID = '{http://schemas.android.com/apk/res/android}'


def run(command, env=None):
    """构建失败立即停止，第三方工具原始输出留给调用方保存。"""
    subprocess.run([str(value) for value in command], env=env, check=True)


def certificate(java, signer, apk):
    """只取公开签名证书摘要，验证重建包与官方初包确实使用同一证书。"""
    output = subprocess.check_output(
        [str(java), '-jar', str(signer), 'verify', '--verbose', '--print-certs', str(apk)],
        text=True,
    )
    match = re.search(r'Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)', output)
    if not match:
        raise ValueError('安装包未通过签名校验或缺少签名证书摘要')
    return match.group(1).lower(), output


def configure_native(directory, source, manifest):
    """从工程配置生成原生清单与图标，不修改官方DEX或原生库。"""
    android = manifest['app-plus']['distribute']['android']
    ET.register_namespace('android', ANDROID[1:-1])
    tree = ET.parse(directory / 'AndroidManifest.xml')
    root = tree.getroot()
    if root.get('package') != android['packagename']:
        raise ValueError('原生初包与当前工程包名不一致')
    excluded = {
        ET.fromstring(item.replace('<uses-permission', '<uses-permission xmlns:android="' +
            ANDROID[1:-1] + '"', 1)).get(ANDROID + 'name')
        for item in android['excludePermissions']
    }
    for item in list(root):
        if item.tag == 'uses-permission' and item.get(ANDROID + 'name') in excluded:
            root.remove(item)
    application = root.find('application')
    for name, setting in [('DCLOUD_READ_PHONE_STATE', 'permissionPhoneState'),
                          ('DCLOUD_WRITE_EXTERNAL_STORAGE', 'permissionExternalStorage')]:
        item = next((item for item in application.findall('meta-data')
                     if item.get(ANDROID + 'name') == name), None)
        if item is None:
            item = ET.SubElement(application, 'meta-data')
        item.set(ANDROID + 'name', name)
        item.set(ANDROID + 'value', android[setting]['request'])
    tree.write(directory / 'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
    # Apktool通过生成的YAML向aapt2传递SDK版本，不能只修改XML后留下旧目标版本。
    config = directory / 'apktool.yml'
    text = config.read_text(encoding='utf-8')
    values = {field: android[field] for field in ['minSdkVersion', 'targetSdkVersion']}
    values.update(versionCode=int(manifest['versionCode']), versionName=manifest['versionName'])
    for field, value in values.items():
        text, count = re.subn(r'(?m)^  ' + field + r':.*$',
                             '  ' + field + ': ' + json.dumps(value, ensure_ascii=False), text)
        if count != 1:
            raise ValueError('原生包缺少唯一的SDK或应用版本配置：' + field)
    config.write_text(text, encoding='utf-8')
    icons = manifest['app-plus']['distribute']['icons']['android']
    icon_files = list((directory / 'res').rglob('icon.png'))
    if not icon_files:
        raise ValueError('原生初包缺少预期的应用图标，请重新生成官方原生包')
    for icon in icon_files:
        density = next((name for name in icons if re.search(r'-' + name + r'(?:-|$)',
                                                          icon.parent.name)), 'xxhdpi')
        shutil.copy2(source / icons[density], icon)


def main():
    """只重建同包名的个人应用，输出校验报告，失败保留已有可用安装包。"""
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['base-apk', 'apktool', 'pack-tools', 'signing-config', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--java', default='java')
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    manifest = json.loads((source / 'src/manifest.json').read_text(encoding='utf-8'))
    app_id = manifest['appid']
    if not re.fullmatch(r'__UNI__[A-Za-z0-9]+', app_id):
        raise ValueError('工程AppID格式无效')
    www = source / 'unpackage/resources' / app_id / 'www'
    if not (www / 'app-service.js').is_file():
        raise ValueError('请先通过HBuilderX导出最新App资源')
    if hashlib.sha256(args.apktool.read_bytes()).hexdigest() != APKTOOL_SHA256:
        raise ValueError('需要官方Apktool 3.0.3，下载文件SHA-256不匹配')
    signer = args.pack_tools / 'apksigner.jar'
    prior_certificate, _ = certificate(args.java, signer, args.base_apk)
    signing = json.loads(args.signing_config.read_text(encoding='utf-8'))
    with tempfile.TemporaryDirectory(prefix='stair-native-') as temporary:
        work = Path(temporary)
        decoded, framework = work / 'decoded', work / 'framework'
        run([args.java, '-jar', args.apktool, 'd', '--no-src', '--frame-path', framework,
             '-o', decoded, args.base_apk])
        configure_native(decoded, source, manifest)
        target = decoded / 'assets/apps' / app_id / 'www'
        if not target.is_dir():
            raise ValueError('原生初包的AppID与当前工程不一致')
        shutil.rmtree(target)
        shutil.copytree(www, target)
        unsigned, aligned, signed = work / 'unsigned.apk', work / 'aligned.apk', work / 'signed.apk'
        run([args.java, '-jar', args.apktool, 'b', '--frame-path', framework,
             '-o', unsigned, decoded])
        aligner = args.pack_tools / 'zipalign/zipalign'
        run([aligner, '-P', '16', '-f', '4', unsigned, aligned])
        env = dict(os.environ, STAIR_STORE_PASS=signing['storePassword'],
                   STAIR_KEY_PASS=signing['keyPassword'])
        run([args.java, '-jar', signer, 'sign', '--ks', signing['storeFile'],
             '--ks-key-alias', signing['alias'], '--ks-pass', 'env:STAIR_STORE_PASS',
             '--key-pass', 'env:STAIR_KEY_PASS', '--out', signed, aligned], env)
        digest, verification = certificate(args.java, signer, signed)
        if digest != prior_certificate:
            raise ValueError('重建包与官方初包的签名证书不一致')
        run([aligner, '-c', '-P', '16', '4', signed])
        resources = sorted(path for path in www.rglob('*') if path.is_file())
        with zipfile.ZipFile(args.base_apk) as base, zipfile.ZipFile(signed) as result:
            if result.testzip():
                raise ValueError('安装包ZIP内容损坏')
            for name in base.namelist():
                if name.endswith('.dex') or name.startswith('lib/'):
                    if base.read(name) != result.read(name):
                        raise ValueError('官方原生代码发生非预期变化：' + name)
            for path in resources:
                name = 'assets/apps/' + app_id + '/www/' + path.relative_to(www).as_posix()
                if result.read(name) != path.read_bytes():
                    raise ValueError('安装包未包含最新导出资源：' + name)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        pending = args.output.with_suffix('.apk.pending')
        shutil.copy2(signed, pending)
        os.replace(pending, args.output)
        report = {'apk': str(args.output), 'sha256': hashlib.sha256(signed.read_bytes()).hexdigest(),
                  'sizeBytes': signed.stat().st_size, 'baseSha256': hashlib.sha256(args.base_apk.read_bytes()).hexdigest(),
                  'nativeCodeMatchesBase': True, 'allExportedResourcesMatch': True,
                  'resourceFiles': len(resources), 'certificateSha256': digest,
                  'signatureVerified': True, 'apktoolVersion': '3.0.3'}
        args.output.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        args.output.with_suffix('.signature.txt').write_text(verification, encoding='utf-8')
        print('本地APK重建及签名校验通过：' + str(args.output))


if __name__ == '__main__':
    main()
